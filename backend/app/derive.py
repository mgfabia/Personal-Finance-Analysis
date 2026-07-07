"""Derived-state rebuild — the transfer matcher.

``rebuild_transfer_matches`` re-derives the ``transfer_matches`` table from the
live transaction set. It runs after every sync (cron tail + webhook background
task) and after any override write that sets/clears ``txn_class_override`` —
always **outside and after** the sync's cursor transaction: derived state never
gates sync correctness (§2). Standalone backfill: ``python -m app.derive``.

Contract (design-notes/transaction-semantics/06):

* Idempotent — a pure function of live rows + durable user state. ``auto``
  matches are wiped and re-derived from scratch each run; ``user`` matches and
  rejection rows are permanent.
* One-to-one — candidates are emitted best-first (closest dates, corroborated
  pairs preferred, deterministic tie-breaks) and the targetless ``ON CONFLICT
  DO NOTHING`` arbitrates against the per-leg UNIQUE constraints, so any
  candidate whose leg is already taken is skipped. Double-matching is
  impossible at the DB level regardless of insert order.
* Tombstone/pending-safe — posted rows only; matches lose a leg → dropped;
  overrides and tags made on a pending row migrate to its posted successor
  (user rulings follow the money, not the row).
* Never matches on names/descriptions — cross-institution descriptions never
  agree. Account masks appearing in the counterparty description are a
  *corroboration* signal (ordering preference + flag), not a match key.

Failure mode if this crashes: pairs are stale; affected legs classify as
``debt_payment``/``transfer_unmatched`` (visible, review-flagged) until the
next run heals them. Never wrong money.
"""

from __future__ import annotations

import logging

import psycopg

from .config import get_settings
from .logging_setup import configure_logging

logger = logging.getLogger("app.derive")

# Serializes concurrent rebuilds (cron tail vs webhook task vs override write).
# xact-scoped: released automatically at commit/rollback.
_LOCK = "SELECT pg_advisory_xact_lock(hashtext('derive:transfer_matches'))"

_DROP_TOMBSTONED = """
DELETE FROM transfer_matches m
USING transactions t
WHERE t.removed_at IS NOT NULL
  AND t.id IN (m.outflow_transaction_id, m.inflow_transaction_id)
"""

# A pending row Plaid replaced posts under a NEW transaction_id (the pending id
# arrives in `removed`, linked via pending_transaction_id). Copy the user's
# ruling onto the posted row exactly once; the tombstoned original keeps its
# rows harmlessly.
_MIGRATE_OVERRIDES = """
INSERT INTO transaction_overrides
        (user_id, transaction_id, category_override, name_override,
         notes, is_hidden, txn_class_override)
SELECT o.user_id, posted.id, o.category_override, o.name_override,
       o.notes, o.is_hidden, o.txn_class_override
FROM transactions posted
JOIN transactions pend
  ON pend.plaid_transaction_id = posted.pending_transaction_id
 AND pend.removed_at IS NOT NULL
JOIN transaction_overrides o ON o.transaction_id = pend.id
WHERE posted.removed_at IS NULL
ON CONFLICT (transaction_id) DO NOTHING
"""

_MIGRATE_TAGS = """
INSERT INTO transaction_tags (transaction_id, tag_id, user_id)
SELECT posted.id, tt.tag_id, tt.user_id
FROM transactions posted
JOIN transactions pend
  ON pend.plaid_transaction_id = posted.pending_transaction_id
 AND pend.removed_at IS NOT NULL
JOIN transaction_tags tt ON tt.transaction_id = pend.id
WHERE posted.removed_at IS NULL
ON CONFLICT (transaction_id, tag_id) DO NOTHING
"""

_DROP_AUTO = "DELETE FROM transfer_matches WHERE source = 'auto'"

_REMATCH = """
INSERT INTO transfer_matches
        (user_id, outflow_transaction_id, inflow_transaction_id, source, corroborated)
SELECT o.user_id, o.id, i.id, 'auto',
       COALESCE(position(ia.mask IN o.name) > 0
                OR position(oa.mask IN i.name) > 0, false)
FROM transactions o
JOIN accounts oa ON oa.id = o.account_id
JOIN transactions i
  ON  i.user_id     = o.user_id
  AND i.amount      = -o.amount                 -- exact, no tolerance
  AND i.account_id <> o.account_id
  AND i.date BETWEEN o.date - 4 AND o.date + 4  -- symmetric: credit/loan
                                                -- inflows can post FIRST
JOIN accounts ia ON ia.id = i.account_id
WHERE o.amount > 0
  AND o.removed_at IS NULL AND i.removed_at IS NULL
  AND NOT o.pending AND NOT i.pending           -- posted rows only
  -- BOTH legs transfer-shaped. 'OTHER' included: PFCv2 recodes v1's generic
  -- other-transfers as OTHER_OTHER; a true leg coded OTHER must stay pairable.
  AND o.pfc_primary IN ('TRANSFER_OUT', 'LOAN_PAYMENTS', 'OTHER')
  AND i.pfc_primary IN ('TRANSFER_IN',  'LOAN_PAYMENTS', 'OTHER')
  -- COALESCE: a row without a counterparties key must count as "not a
  -- payment app", not as NULL (which would exclude it from matching).
  AND NOT COALESCE(o.raw -> 'counterparties' @> '[{"type":"payment_app"}]', false)
  AND NOT COALESCE(i.raw -> 'counterparties' @> '[{"type":"payment_app"}]', false)
  AND NOT EXISTS (SELECT 1 FROM transfer_match_rejections r     -- pair veto
                  WHERE r.txn_a = LEAST(o.id, i.id)
                    AND r.txn_b = GREATEST(o.id, i.id))
  AND NOT EXISTS (SELECT 1 FROM transaction_overrides ov        -- leg veto:
                  WHERE ov.transaction_id IN (o.id, i.id)       -- the user
                    AND ov.txn_class_override IS NOT NULL)      -- ruled already
ORDER BY abs(i.date - o.date),                          -- closest dates win
         COALESCE(position(ia.mask IN o.name) > 0
                  OR position(oa.mask IN i.name) > 0, false) DESC,
         o.date, o.id, i.id                             -- deterministic ties
ON CONFLICT DO NOTHING
"""


def rebuild_transfer_matches(conn: psycopg.Connection) -> dict[str, int]:
    """Re-derive transfer_matches on an open connection. Returns step counts."""
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute(_LOCK)
            cur.execute(_DROP_TOMBSTONED)
            dropped = cur.rowcount
            cur.execute(_MIGRATE_OVERRIDES)
            migrated = cur.rowcount
            cur.execute(_MIGRATE_TAGS)
            migrated_tags = cur.rowcount
            cur.execute(_DROP_AUTO)
            cur.execute(_REMATCH)
            matched = cur.rowcount
    result = {
        "dropped_tombstoned": dropped,
        "migrated_overrides": migrated,
        "migrated_tags": migrated_tags,
        "auto_matched": matched,
    }
    logger.info("derive.transfer_matches", extra=result)
    return result


def rebuild() -> dict[str, int]:
    """Open a connection and rebuild — the sync-tail / backfill entrypoint."""
    with psycopg.connect(get_settings().require_database_url()) as conn:
        return rebuild_transfer_matches(conn)


def main() -> int:
    configure_logging()
    result = rebuild()
    logger.info("derive.complete", extra=result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
