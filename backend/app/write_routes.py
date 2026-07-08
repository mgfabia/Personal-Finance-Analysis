"""Write API — user judgment on the transaction-semantics layer (0003).

Three kinds of durable user intent, all keyed to stable internal ids so they
survive re-syncs and matcher rebuilds:

* **Overrides** (``transaction_overrides``) — per-row rulings: category, name,
  notes, hidden, and ``txn_class_override`` (precedence 1 in the 0004 CASE).
* **Tags** — the registry + per-transaction assignment.
* **Transfer pairs** — manual links (``source='user'``, permanent) and
  rejections (pair-scoped tombstones the matcher must never re-propose).

Writes that change pairing inputs re-run the matcher inline — it's a few
milliseconds at this scale, and the response then reflects the new state.
"""

from __future__ import annotations

import logging
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import require_auth
from .db import connect
from .derive import rebuild_transfer_matches

import plaid
from plaid.model.transactions_refresh_request import TransactionsRefreshRequest

from .config import get_settings
from .crypto import decrypt_token
from .plaid_client import get_plaid_client
from .plaid_routes import _plaid_error

logger = logging.getLogger("app.write")

router = APIRouter(prefix="/api", tags=["write"])

TxnClass = Literal[
    "spending", "income", "refund", "internal_transfer",
    "saving_investing", "debt_payment", "cash",
]

# Columns the override PUT may set, in a fixed order for the upsert.
_OVERRIDE_COLS = (
    "category_override", "name_override", "notes", "is_hidden", "txn_class_override",
)


class OverrideBody(BaseModel):
    """Partial update: only keys present in the request are written; a key set
    to null clears that override. (model_fields_set distinguishes the two.)"""
    category_override: str | None = None
    name_override: str | None = None
    notes: str | None = None
    is_hidden: bool | None = None
    txn_class_override: TxnClass | None = None


def _require_txn(cur, txn_id: uuid.UUID, user_id: str) -> None:
    cur.execute(
        "SELECT 1 FROM transactions WHERE id = %s AND user_id = %s",
        (txn_id, user_id),
    )
    if cur.fetchone() is None:
        raise HTTPException(404, "transaction not found")


@router.put("/transactions/{txn_id}/override")
def put_override(
    txn_id: uuid.UUID,
    body: OverrideBody,
    user_id: str = Depends(require_auth),
) -> dict:
    provided = body.model_fields_set & set(_OVERRIDE_COLS)
    if not provided:
        raise HTTPException(422, "no override fields provided")

    sets = ", ".join(f"{c} = EXCLUDED.{c}" for c in _OVERRIDE_COLS if c in provided)
    values = {c: getattr(body, c) for c in _OVERRIDE_COLS}

    with connect() as conn:
        with conn.cursor() as cur:
            _require_txn(cur, txn_id, user_id)
            cur.execute(
                "INSERT INTO transaction_overrides "
                "(user_id, transaction_id, category_override, name_override, "
                " notes, is_hidden, txn_class_override) "
                "VALUES (%s, %s, %s, %s, %s, COALESCE(%s, false), %s) "
                f"ON CONFLICT (transaction_id) DO UPDATE SET {sets}",
                (
                    user_id, txn_id, values["category_override"],
                    values["name_override"], values["notes"],
                    values["is_hidden"], values["txn_class_override"],
                ),
            )
        # A class ruling changes matcher inputs (overridden legs are vetoed):
        # re-derive inside the same request so the read-back is consistent.
        if "txn_class_override" in provided:
            rebuild_transfer_matches(conn)
    return {"transaction_id": str(txn_id), "updated": sorted(provided)}


# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------
class TagBody(BaseModel):
    name: str
    color: str | None = None


class TagPatch(BaseModel):
    name: str | None = None
    color: str | None = None


class TxnTagsBody(BaseModel):
    tag_ids: list[uuid.UUID]


@router.post("/tags", status_code=201)
def create_tag(body: TagBody, user_id: str = Depends(require_auth)) -> dict:
    """Idempotent create: posting an existing name returns the existing tag."""
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "tag name must be non-empty")
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO tags (user_id, name, color) VALUES (%s, %s, %s) "
                "ON CONFLICT (user_id, name) DO UPDATE SET color = "
                "COALESCE(EXCLUDED.color, tags.color) "
                "RETURNING id, name, color",
                (user_id, name, body.color),
            )
            row = cur.fetchone()
    return {"id": str(row[0]), "name": row[1], "color": row[2]}


@router.patch("/tags/{tag_id}")
def update_tag(
    tag_id: uuid.UUID, body: TagPatch, user_id: str = Depends(require_auth)
) -> dict:
    if body.name is not None and not body.name.strip():
        raise HTTPException(422, "tag name must be non-empty")
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE tags SET name = COALESCE(%s, name), "
                "color = COALESCE(%s, color) "
                "WHERE id = %s AND user_id = %s RETURNING id, name, color",
                (body.name and body.name.strip(), body.color, tag_id, user_id),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "tag not found")
    return {"id": str(row[0]), "name": row[1], "color": row[2]}


@router.delete("/tags/{tag_id}")
def delete_tag(tag_id: uuid.UUID, user_id: str = Depends(require_auth)) -> dict:
    """Deletes the tag and (via FK cascade) its transaction assignments."""
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM tags WHERE id = %s AND user_id = %s", (tag_id, user_id)
            )
            if cur.rowcount == 0:
                raise HTTPException(404, "tag not found")
    return {"deleted": str(tag_id)}


@router.put("/transactions/{txn_id}/tags")
def set_transaction_tags(
    txn_id: uuid.UUID, body: TxnTagsBody, user_id: str = Depends(require_auth)
) -> dict:
    """Replace the transaction's tag set."""
    with connect() as conn:
        with conn.cursor() as cur:
            _require_txn(cur, txn_id, user_id)
            if body.tag_ids:
                cur.execute(
                    "SELECT count(*) FROM tags WHERE user_id = %s AND id = ANY(%s)",
                    (user_id, body.tag_ids),
                )
                if cur.fetchone()[0] != len(set(body.tag_ids)):
                    raise HTTPException(404, "one or more tags not found")
            cur.execute(
                "DELETE FROM transaction_tags WHERE transaction_id = %s", (txn_id,)
            )
            for tag_id in set(body.tag_ids):
                cur.execute(
                    "INSERT INTO transaction_tags (transaction_id, tag_id, user_id) "
                    "VALUES (%s, %s, %s)",
                    (txn_id, tag_id, user_id),
                )
    return {"transaction_id": str(txn_id), "tag_ids": [str(t) for t in set(body.tag_ids)]}


# ---------------------------------------------------------------------------
# Accounts — user display name
# ---------------------------------------------------------------------------
class AccountPatch(BaseModel):
    """Partial update: only keys present in the request are written; an explicit
    null (or blank) clears the display name back to the bank's."""
    display_name: str | None = None


@router.patch("/accounts/{account_id}")
def update_account(
    account_id: uuid.UUID, body: AccountPatch, user_id: str = Depends(require_auth)
) -> dict:
    if "display_name" not in body.model_fields_set:
        raise HTTPException(422, "no account fields provided")
    display_name = (body.display_name or "").strip() or None
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE accounts SET display_name = %s "
                "WHERE id = %s AND user_id = %s "
                "RETURNING id, display_name, name",
                (display_name, account_id, user_id),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "account not found")
    return {"id": str(row[0]), "display_name": row[1], "name": row[2]}


# ---------------------------------------------------------------------------
# Transfer pairs — manual link / unlink / reject
# ---------------------------------------------------------------------------
class TransferBody(BaseModel):
    outflow_transaction_id: uuid.UUID
    inflow_transaction_id: uuid.UUID


@router.post("/transfers", status_code=201)
def create_transfer(
    body: TransferBody, user_id: str = Depends(require_auth)
) -> dict:
    """Manually pair two legs the matcher missed. Permanent (source='user'):
    rebuilds never remove it. Clears any prior rejection of this exact pair and
    displaces any auto match currently holding either leg."""
    out_id, in_id = body.outflow_transaction_id, body.inflow_transaction_id
    if out_id == in_id:
        raise HTTPException(422, "a transfer needs two different transactions")

    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, amount, account_id FROM transactions "
                "WHERE id = ANY(%s) AND user_id = %s AND removed_at IS NULL",
                ([out_id, in_id], user_id),
            )
            rows = {r[0]: r for r in cur.fetchall()}
            if set(rows) != {out_id, in_id}:
                raise HTTPException(404, "transaction not found")
            if rows[out_id][1] is None or rows[out_id][1] <= 0 or rows[in_id][1] >= 0:
                raise HTTPException(422, "outflow must be amount > 0 and inflow amount < 0")
            if rows[out_id][1] != -rows[in_id][1]:
                raise HTTPException(422, "legs must have equal opposite amounts")
            if rows[out_id][2] == rows[in_id][2]:
                raise HTTPException(422, "legs must be on different accounts")

            # The user's link overrides prior judgments and any auto pairing.
            cur.execute(
                "DELETE FROM transfer_match_rejections "
                "WHERE txn_a = LEAST(%s::uuid, %s::uuid) "
                "  AND txn_b = GREATEST(%s::uuid, %s::uuid)",
                (out_id, in_id, out_id, in_id),
            )
            cur.execute(
                "DELETE FROM transfer_matches "
                "WHERE outflow_transaction_id IN (%s, %s) "
                "   OR inflow_transaction_id IN (%s, %s)",
                (out_id, in_id, out_id, in_id),
            )
            cur.execute(
                "INSERT INTO transfer_matches "
                "(user_id, outflow_transaction_id, inflow_transaction_id, source) "
                "VALUES (%s, %s, %s, 'user') RETURNING id",
                (user_id, out_id, in_id),
            )
            match_id = cur.fetchone()[0]
        # Displaced auto legs may re-pair elsewhere.
        rebuild_transfer_matches(conn)
    return {"id": str(match_id), "source": "user"}


@router.delete("/transfers/{match_id}")
def delete_transfer(
    match_id: uuid.UUID,
    user_id: str = Depends(require_auth),
    reject: bool = False,
) -> dict:
    """Unlink a pair. With ``reject=true`` the pair is also tombstoned so the
    matcher never re-proposes it (without it, an auto pair will simply be
    re-derived on the next rebuild — plain unlink is only meaningful for
    user-created pairs)."""
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM transfer_matches WHERE id = %s AND user_id = %s "
                "RETURNING outflow_transaction_id, inflow_transaction_id",
                (match_id, user_id),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "transfer match not found")
            if reject:
                cur.execute(
                    "INSERT INTO transfer_match_rejections (user_id, txn_a, txn_b) "
                    "VALUES (%s, LEAST(%s::uuid, %s::uuid), GREATEST(%s::uuid, %s::uuid)) "
                    "ON CONFLICT (txn_a, txn_b) DO NOTHING",
                    (user_id, row[0], row[1], row[0], row[1]),
                )
        # Freed legs may pair elsewhere (or re-pair, if not rejected).
        rebuild_transfer_matches(conn)
    return {"deleted": str(match_id), "rejected": reject}


@router.post("/transactions/refresh", status_code=202)
def refresh_transactions(user_id: str = Depends(require_auth)) -> dict:
    """Force Plaid to check every linked bank for new transactions (billed per
    call). Async: Plaid later fires SYNC_UPDATES_AVAILABLE, which the webhook
    path syncs. A cooldown caps cost."""
    cooldown = get_settings().refresh_cooldown_seconds

    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, access_token_encrypted, "
                "  EXTRACT(EPOCH FROM (now() - max(last_manual_refresh_at) OVER ())) "
                "FROM items "
                "WHERE user_id = %s AND retired_at IS NULL "
                "  AND access_token_encrypted IS NOT NULL",
                (user_id,),
            )
            rows = cur.fetchall()

    if not rows:
        raise HTTPException(404, "no linked banks to refresh")

    # `since` = seconds since the most recent manual refresh across ALL the
    # user's items (the window function repeats the global max on every row).
    since = rows[0][2]
    if since is not None and since < cooldown:
        raise HTTPException(
            429,
            detail={
                "message": "Refreshed recently — try again shortly.",
                "retry_after": int(cooldown - since),
            },
        )

    client = get_plaid_client()
    refreshed, failed = [], []
    for item_id, enc_token, _ in rows:
        try:
            client.transactions_refresh(
                TransactionsRefreshRequest(access_token=decrypt_token(enc_token))
            )
            refreshed.append(item_id)
        except plaid.ApiException as exc:
            failed.append(_plaid_error(exc).detail.get("error_code"))

    # Stamp only the items that succeeded, in one write AFTER the Plaid I/O, so a
    # fully-failed attempt (e.g. add-on off) doesn't lock the server cooldown.
    if refreshed:
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE items SET last_manual_refresh_at = now() WHERE id = ANY(%s)",
                    (refreshed,),
                )

    if not refreshed:
        # Nothing succeeded — surface Plaid's reason (covers add-on-not-enabled).
        raise HTTPException(502, detail={"source": "plaid", "failed": failed})

    return {"refreshed": len(refreshed), "failed": failed, "cooldown_seconds": cooldown}

