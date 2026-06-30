"""Transactions sync engine — Phase 3.

``run_sync`` is the core internal routine: for one item it drains
``/transactions/sync`` and applies the result correctly and idempotently. It is
the durability backbone — the nightly cron (``python -m app.sync``) calls it for
every item, and Phase 4's webhook handler will trigger the same function.

Two non-negotiables are enforced here:

* §1 — **per-item Postgres advisory lock.** ``pg_try_advisory_lock(hashtext(
  plaid_item_id))`` is taken on a dedicated session connection *before* any Plaid
  I/O, with **no** DB transaction held across the (slow) HTTP loop. The cron and a
  webhook can both target the same item from separate processes; the non-blocking
  ``try`` variant makes the loser *skip* (the item still gets synced, just not
  twice). Released in ``finally``.
* §2 — **transactionally-correct apply.** We loop until ``has_more`` is false,
  accumulating ``added`` / ``modified`` / ``removed``, then in a **single** write
  transaction: upsert added+modified, tombstone removed, and write the new
  ``transactions_cursor`` **strictly last**. The cursor never advances ahead of
  the rows it represents, so the failure mode is always "reprocess," never "skip."
"""

from __future__ import annotations

import json
from typing import Any

import psycopg
from psycopg.types.json import Json

import plaid
from plaid.model.accounts_get_request import AccountsGetRequest
from plaid.model.transactions_sync_request import TransactionsSyncRequest

from .config import get_settings
from .crypto import decrypt_token
from .db import connect
from .plaid_client import get_plaid_client
from .reconcile import reconcile_accounts

# Plaid caps a sync page at 500. Personal histories fit in a handful of pages.
TXN_PAGE_SIZE = 500

_ITEM_COLUMNS = (
    "id", "plaid_item_id", "user_id", "access_token_encrypted", "transactions_cursor"
)


def _raw(obj: Any) -> Json:
    """Wrap a Plaid payload for jsonb storage, tolerating datetime/date values."""
    return Json(obj, dumps=lambda o: json.dumps(o, default=str))


# ---------------------------------------------------------------------------
# Plaid pagination
# ---------------------------------------------------------------------------
def _drain(client, access_token: str, cursor: str | None) -> tuple[list, list, list, str]:
    """Loop /transactions/sync until has_more is false; return all three sets
    (as plain dicts) plus the final next_cursor."""
    added: list[dict] = []
    modified: list[dict] = []
    removed: list[dict] = []
    cur = cursor or ""

    while True:
        kwargs: dict[str, Any] = {"access_token": access_token, "count": TXN_PAGE_SIZE}
        if cur:  # omit on the very first sync (no cursor yet)
            kwargs["cursor"] = cur
        resp = client.transactions_sync(TransactionsSyncRequest(**kwargs))

        added.extend(t.to_dict() for t in resp["added"])
        modified.extend(t.to_dict() for t in resp["modified"])
        removed.extend(r.to_dict() for r in resp["removed"])

        cur = resp["next_cursor"]
        if not resp["has_more"]:
            break

    return added, modified, removed, cur


# ---------------------------------------------------------------------------
# DB writes
# ---------------------------------------------------------------------------
def _account_map(cur: psycopg.Cursor, item_id) -> dict[str, Any]:
    """{plaid_account_id: accounts.id} for the item's accounts."""
    cur.execute(
        "SELECT plaid_account_id, id FROM accounts WHERE current_item_id = %s",
        (item_id,),
    )
    return {row[0]: row[1] for row in cur.fetchall()}


_UPSERT_TXN = (
    "INSERT INTO transactions ("
    "user_id, account_id, plaid_transaction_id, pending, pending_transaction_id, "
    "amount, currency, date, datetime, name, merchant_name, payment_channel, "
    "account_owner, pfc_primary, pfc_detailed, category, removed_at, raw) "
    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NULL, %s) "
    "ON CONFLICT (plaid_transaction_id) DO UPDATE SET "
    "account_id = EXCLUDED.account_id, pending = EXCLUDED.pending, "
    "pending_transaction_id = EXCLUDED.pending_transaction_id, "
    "amount = EXCLUDED.amount, currency = EXCLUDED.currency, date = EXCLUDED.date, "
    "datetime = EXCLUDED.datetime, name = EXCLUDED.name, "
    "merchant_name = EXCLUDED.merchant_name, payment_channel = EXCLUDED.payment_channel, "
    "account_owner = EXCLUDED.account_owner, pfc_primary = EXCLUDED.pfc_primary, "
    "pfc_detailed = EXCLUDED.pfc_detailed, category = EXCLUDED.category, "
    # added/modified means the txn is live again — clear any prior tombstone.
    "removed_at = NULL, raw = EXCLUDED.raw"
)


def _upsert_transaction(cur: psycopg.Cursor, user_id, account_id, t: dict) -> None:
    pfc = t.get("personal_finance_category") or {}
    cur.execute(
        _UPSERT_TXN,
        (
            user_id, account_id, t["transaction_id"], t.get("pending", False),
            t.get("pending_transaction_id"), t.get("amount"),
            t.get("iso_currency_code"), t.get("date"), t.get("datetime"),
            t.get("name"), t.get("merchant_name"), t.get("payment_channel"),
            t.get("account_owner"), pfc.get("primary"), pfc.get("detailed"),
            t.get("category"), _raw(t),
        ),
    )


def _tombstone_removed(cur: psycopg.Cursor, plaid_transaction_id: str) -> None:
    """Soft-delete a removed transaction (idempotent: only stamps live rows)."""
    cur.execute(
        "UPDATE transactions SET removed_at = now() "
        "WHERE plaid_transaction_id = %s AND removed_at IS NULL",
        (plaid_transaction_id,),
    )


# ---------------------------------------------------------------------------
# The engine
# ---------------------------------------------------------------------------
def run_sync(item: dict[str, Any]) -> dict[str, Any]:
    """Sync transactions for one item under a per-item advisory lock.

    ``item`` carries id, plaid_item_id, user_id, access_token_encrypted,
    transactions_cursor. Returns a result dict; raises on Plaid/DB errors (the
    caller records them — the cursor is untouched on failure, so re-running
    reprocesses).
    """
    plaid_item_id = item["plaid_item_id"]
    settings = get_settings()

    # Dedicated session connection for the advisory lock. autocommit=True so the
    # lock (a session-level resource) is held independently of the short write
    # transaction we open at the very end.
    conn = psycopg.connect(settings.require_database_url(), autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(hashtext(%s))", (plaid_item_id,))
            if not cur.fetchone()[0]:
                return {"item": plaid_item_id, "status": "skipped_locked"}

        try:
            access_token = decrypt_token(item["access_token_encrypted"])
            client = get_plaid_client()

            # --- Plaid I/O: no DB transaction open during the HTTP loop (§1) ---
            added, modified, removed, next_cursor = _drain(
                client, access_token, item["transactions_cursor"]
            )

            # Resolve each txn's account. Accounts were reconciled at link, but a
            # brand-new account could appear between link and sync — lazily
            # reconcile once if so (reuses the Phase 2 function), then re-map.
            with conn.cursor() as cur:
                amap = _account_map(cur, item["id"])
            referenced = {t["account_id"] for t in added} | {t["account_id"] for t in modified}
            if referenced - amap.keys():
                accts = [
                    a.to_dict()
                    for a in client.accounts_get(
                        AccountsGetRequest(access_token=access_token)
                    )["accounts"]
                ]
                with conn.transaction():
                    reconcile_accounts(conn, item["user_id"], item["id"], accts)
                with conn.cursor() as cur:
                    amap = _account_map(cur, item["id"])
                if referenced - amap.keys():
                    raise RuntimeError(
                        f"transactions reference unknown accounts: "
                        f"{sorted(referenced - amap.keys())}"
                    )

            # --- Single write transaction; cursor written strictly last (§2) ---
            with conn.transaction():
                with conn.cursor() as cur:
                    for t in added:
                        _upsert_transaction(cur, item["user_id"], amap[t["account_id"]], t)
                    for t in modified:
                        _upsert_transaction(cur, item["user_id"], amap[t["account_id"]], t)
                    for r in removed:
                        _tombstone_removed(cur, r["transaction_id"])
                    cur.execute(
                        "UPDATE items SET transactions_cursor = %s, "
                        "last_synced_at = now(), last_error = NULL WHERE id = %s",
                        (next_cursor, item["id"]),
                    )

            return {
                "item": plaid_item_id,
                "status": "synced",
                "added": len(added),
                "modified": len(modified),
                "removed": len(removed),
            }
        finally:
            with conn.cursor() as cur:
                cur.execute("SELECT pg_advisory_unlock(hashtext(%s))", (plaid_item_id,))
    finally:
        conn.close()


def _record_error(item: dict[str, Any], exc: Exception) -> None:
    """Persist a sync failure to items.last_error (cursor stays put → reprocess)."""
    detail: dict[str, Any] = {"message": str(exc)}
    if isinstance(exc, plaid.ApiException):
        try:
            body = json.loads(exc.body)
            detail = {
                "error_code": body.get("error_code"),
                "error_message": body.get("error_message"),
            }
        except (ValueError, TypeError, AttributeError):
            pass
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE items SET last_error = %s WHERE id = %s",
                (_raw(detail), item["id"]),
            )


def sync_all_items() -> list[dict[str, Any]]:
    """Run transactions sync for every live item — the nightly cron entrypoint."""
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT {', '.join(_ITEM_COLUMNS)} FROM items "
                "WHERE retired_at IS NULL AND access_token_encrypted IS NOT NULL"
            )
            items = [dict(zip(_ITEM_COLUMNS, row)) for row in cur.fetchall()]

    results: list[dict[str, Any]] = []
    for item in items:
        try:
            results.append(run_sync(item))
        except Exception as exc:  # one item's failure must not stop the others
            _record_error(item, exc)
            results.append({"item": item["plaid_item_id"], "status": "error", "error": str(exc)})
    return results


def main() -> int:
    results = sync_all_items()
    for r in results:
        print(r)
    # Non-zero exit if any item errored, so the cron surfaces failures.
    return 1 if any(r.get("status") == "error" for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
