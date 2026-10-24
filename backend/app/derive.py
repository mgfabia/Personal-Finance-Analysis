"""Derived-state rebuild — the obligation matcher and the transfer matcher.

``rebuild_matches`` re-derives ``obligation_matches`` (0007) and
``transfer_matches`` from the live transaction set. It runs after every sync
(cron tail + webhook background task), after any override write that
sets/clears ``txn_class_override``, and after any obligation write — always
**outside and after** the sync's cursor transaction: derived state never gates
sync correctness (§2). Standalone backfill: ``python -m app.derive``.

Obligations run first: they are user-declared intent, so a row an obligation
claims is never offered to the transfer matcher. Obligation matches are fully
derived (no user-owned rows) and are wiped and re-derived on every run.

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
from collections import defaultdict

import psycopg

from .config import get_settings
from .logging_setup import configure_logging

logger = logging.getLogger("app.derive")

# Serializes concurrent rebuilds (cron tail vs webhook task vs user writes). The
# key predates obligations; it is kept so old and new code serialize mid-deploy.
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

_DROP_OBLIGATION_MATCHES = "DELETE FROM obligation_matches"

# Every (obligation, month, row) that could belong to that month's event. Runs
# after _DROP_AUTO, so transfer_matches holds only user pairs here — those legs
# stay out. Months span the user's data (or the obligation's start/end); the
# expected date clamps day_of_month to the month's last day. day_window <= 10
# (CHECK) keeps a row from being near two months' expected dates.
_OBLIGATION_CANDIDATES = """
WITH months AS (
    SELECT ob.id AS obligation_id, gs::date AS period,
           make_date(extract(year FROM gs)::int, extract(month FROM gs)::int,
                     LEAST(ob.day_of_month,
                           extract(day FROM gs + interval '1 month - 1 day')::int))
               AS expected
    FROM obligations ob
    CROSS JOIN LATERAL generate_series(
        COALESCE(ob.start_month::timestamp,
                 (SELECT date_trunc('month', min(date)::timestamp)
                  FROM transactions WHERE user_id = ob.user_id)),
        COALESCE(ob.end_month::timestamp,
                 (SELECT date_trunc('month', max(date)::timestamp) + interval '1 month'
                  FROM transactions WHERE user_id = ob.user_id)),
        interval '1 month') gs
    WHERE ob.active
)
SELECT ob.id AS obligation_id, t.id AS transaction_id, ob.user_id, mo.period,
       CASE WHEN t.amount > 0 THEN 'payment' ELSE 'reimbursement' END AS role,
       CASE WHEN t.amount > 0 THEN 1
            ELSE round(-t.amount / ob.reimbursement_amount)::int END AS shares,
       ob.reimbursement_count
FROM months mo
JOIN obligations ob ON ob.id = mo.obligation_id
JOIN transactions t
  ON  t.user_id = ob.user_id
  AND t.date BETWEEN mo.expected - ob.day_window AND mo.expected + ob.day_window
LEFT JOIN transaction_overrides o ON o.transaction_id = t.id
CROSS JOIN LATERAL (
    SELECT string_agg(c ->> 'name', ' ') AS names
    FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(t.raw -> 'counterparties') = 'array'
             THEN t.raw -> 'counterparties' ELSE '[]'::jsonb END) c
) cp
WHERE t.removed_at IS NULL
  AND NOT t.pending                                   -- posted rows only
  AND (ob.account_id IS NULL OR t.account_id = ob.account_id)
  AND (ob.match_text IS NULL
       OR position(lower(ob.match_text) IN lower(concat_ws(' ',
              o.name_override, t.merchant_name, t.name, cp.names))) > 0)
  -- the user ruled already — unless the ruling agrees with what the obligation
  -- would assign (then grouping it only adds the category and the month)
  AND (o.txn_class_override IS NULL
       OR o.txn_class_override = CASE WHEN t.amount > 0 THEN 'spending' ELSE 'refund' END)
  AND NOT EXISTS (SELECT 1 FROM transfer_matches m    -- user-paired legs
                  WHERE t.id IN (m.outflow_transaction_id, m.inflow_transaction_id))
  AND (
        (t.amount > 0 AND abs(t.amount - ob.amount) <= ob.amount_tolerance)
     -- an inflow covering k whole shares (k = 2 is a combined payment), each
     -- within the per-share tolerance
     OR (t.amount < 0 AND ob.reimbursement_count > 0
         AND round(-t.amount / ob.reimbursement_amount)
             BETWEEN 1 AND ob.reimbursement_count
         AND abs(-t.amount - round(-t.amount / ob.reimbursement_amount)
                             * ob.reimbursement_amount)
             <= ob.reimbursement_tolerance * round(-t.amount / ob.reimbursement_amount))
  )
ORDER BY abs(t.date - mo.expected),                   -- closest to expected wins
         t.date, t.id, ob.id                          -- deterministic ties
"""

_INSERT_OBLIGATION_MATCH = """
INSERT INTO obligation_matches
        (user_id, obligation_id, transaction_id, period, role, shares)
VALUES (%s, %s, %s, %s, %s, %s)
"""

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
  AND NOT EXISTS (SELECT 1 FROM obligation_matches om           -- an obligation
                  WHERE om.transaction_id IN (o.id, i.id))      -- claimed it
ORDER BY abs(i.date - o.date),                          -- closest dates win
         COALESCE(position(ia.mask IN o.name) > 0
                  OR position(oa.mask IN i.name) > 0, false) DESC,
         o.date, o.id, i.id                             -- deterministic ties
ON CONFLICT DO NOTHING
"""


def _match_obligations(cur: psycopg.Cursor) -> int:
    """Assign candidates best-first: a row joins at most one event, each month
    gets at most one payment, and reimbursements fill until the month's shares
    are used up (a combined payment that would overshoot is skipped)."""
    cur.execute(_OBLIGATION_CANDIDATES)
    used: set = set()
    paid: set = set()
    shares_taken: dict = defaultdict(int)
    picks = []
    for ob_id, txn_id, user_id, period, role, shares, max_shares in cur.fetchall():
        if txn_id in used:
            continue
        key = (ob_id, period)
        if role == "payment":
            if key in paid:
                continue
            paid.add(key)
        else:
            if shares_taken[key] + shares > max_shares:
                continue
            shares_taken[key] += shares
        used.add(txn_id)
        picks.append((user_id, ob_id, txn_id, period, role, shares))
    if picks:
        cur.executemany(_INSERT_OBLIGATION_MATCH, picks)
    return len(picks)


def rebuild_matches(conn: psycopg.Connection) -> dict[str, int]:
    """Re-derive obligation and transfer matches on an open connection.
    Returns step counts."""
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
            cur.execute(_DROP_OBLIGATION_MATCHES)
            obligation_matched = _match_obligations(cur)
            cur.execute(_REMATCH)
            matched = cur.rowcount
    result = {
        "dropped_tombstoned": dropped,
        "migrated_overrides": migrated,
        "migrated_tags": migrated_tags,
        "obligation_matched": obligation_matched,
        "auto_matched": matched,
    }
    logger.info("derive.transfer_matches", extra=result)
    return result


def rebuild() -> dict[str, int]:
    """Open a connection and rebuild — the sync-tail / backfill entrypoint."""
    with psycopg.connect(get_settings().require_database_url()) as conn:
        return rebuild_matches(conn)


def main() -> int:
    configure_logging()
    result = rebuild()
    logger.info("derive.complete", extra=result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
