"""Account reconciliation — §3 "account = identity, item = provenance".

On every link/exchange we receive the *current* item's accounts. An account is
the same real-world account across re-links even though Plaid hands it a new
``account_id`` each time. So instead of blindly inserting, we match each incoming
account to an existing row and re-point it at the new item — history stays
attached to the account and never fractures (net worth stays continuous).

Match priority:
  1. ``persistent_account_id`` — Plaid's stable cross-link anchor (when present).
  2. ``plaid_account_id`` — same item re-exchanged (id unchanged).
  3. ``(mask, type, subtype, name)`` **within the same institution** — re-link where
     Plaid gave no persistent id; only trusted when it identifies exactly one
     existing row (never guess on an ambiguous match — insert a fresh row instead).
     The institution scope is load-bearing: without it, two *different* banks whose
     accounts share a fingerprint (e.g. any two Plaid Sandbox banks, which all
     return the same canonical account set with null persistent ids) would be
     wrongly merged. A fingerprint only identifies "the same account" within one
     bank.

Phase 2 is almost always the empty-table case (everything inserts). The matching
paths earn their keep at Phase 6 (re-auth/reconnect), which reuses this function.

Runs inside the caller's transaction (the connection from db.connect()).
"""

from __future__ import annotations

import json
from typing import Any

import psycopg
from psycopg.types.json import Json


def _raw(obj: Any) -> Json:
    """Wrap a Plaid payload for jsonb storage, tolerating datetime/date values."""
    return Json(obj, dumps=lambda o: json.dumps(o, default=str))


def _find_existing(
    cur: psycopg.Cursor,
    user_id: str,
    institution_id: str | None,
    persistent_account_id: str | None,
    plaid_account_id: str,
    mask: str | None,
    type_: str | None,
    subtype: str | None,
    name: str | None,
) -> str | None:
    """Return an existing accounts.id this Plaid account maps to, or None."""
    # 1. Stable persistent anchor.
    if persistent_account_id:
        cur.execute(
            "SELECT id FROM accounts WHERE user_id = %s AND persistent_account_id = %s",
            (user_id, persistent_account_id),
        )
        row = cur.fetchone()
        if row:
            return str(row[0])

    # 2. Same item re-exchanged — the per-item account_id is unchanged.
    cur.execute(
        "SELECT id FROM accounts WHERE user_id = %s AND plaid_account_id = %s",
        (user_id, plaid_account_id),
    )
    row = cur.fetchone()
    if row:
        return str(row[0])

    # 3. Re-link with no persistent id: fall back to attributes, but only within
    #    the SAME institution and only when they pin down exactly one row. The
    #    join to items scopes the fingerprint to one bank (see module docstring) —
    #    without it, lookalike accounts at different banks merge. IS NOT DISTINCT
    #    FROM treats NULLs as equal.
    if not persistent_account_id:
        cur.execute(
            "SELECT a.id FROM accounts a "
            "JOIN items i ON i.id = a.current_item_id "
            "WHERE a.user_id = %s "
            "AND i.plaid_institution_id IS NOT DISTINCT FROM %s "
            "AND a.mask IS NOT DISTINCT FROM %s "
            "AND a.type IS NOT DISTINCT FROM %s "
            "AND a.subtype IS NOT DISTINCT FROM %s "
            "AND a.name IS NOT DISTINCT FROM %s",
            (user_id, institution_id, mask, type_, subtype, name),
        )
        rows = cur.fetchall()
        if len(rows) == 1:
            return str(rows[0][0])

    return None


def reconcile_accounts(
    conn: psycopg.Connection,
    user_id: str,
    item_id: str,
    accounts: list[dict[str, Any]],
    institution_id: str | None,
) -> dict[str, Any]:
    """Upsert the item's accounts by identity; re-point them at ``item_id``.

    ``accounts`` are Plaid account payloads as plain dicts (account.to_dict()).
    ``institution_id`` is the linked item's Plaid institution — it scopes the
    fingerprint fallback so only same-bank accounts can match (§3).
    Returns a summary: counts plus a per-account action for the response/log.
    """
    inserted = 0
    matched = 0
    summary: list[dict[str, Any]] = []

    with conn.cursor() as cur:
        for acct in accounts:
            plaid_account_id = acct["account_id"]
            persistent_account_id = acct.get("persistent_account_id")
            name = acct.get("name")
            official_name = acct.get("official_name")
            mask = acct.get("mask")
            type_ = acct.get("type")
            subtype = acct.get("subtype")

            balances = acct.get("balances") or {}
            current_balance = balances.get("current")
            available_balance = balances.get("available")
            credit_limit = balances.get("limit")
            currency = balances.get("iso_currency_code")

            existing_id = _find_existing(
                cur, user_id, institution_id, persistent_account_id, plaid_account_id,
                mask, type_, subtype, name,
            )

            if existing_id is not None:
                # Re-point at the current item and refresh metadata/balances.
                # COALESCE keeps a previously-known persistent id if this link
                # didn't supply one.
                cur.execute(
                    "UPDATE accounts SET "
                    "current_item_id = %s, plaid_account_id = %s, "
                    "persistent_account_id = COALESCE(%s, persistent_account_id), "
                    "name = %s, official_name = %s, mask = %s, "
                    "type = %s, subtype = %s, currency = %s, "
                    "current_balance = %s, available_balance = %s, credit_limit = %s, "
                    "balance_last_updated = now(), raw = %s "
                    "WHERE id = %s",
                    (
                        item_id, plaid_account_id, persistent_account_id,
                        name, official_name, mask, type_, subtype, currency,
                        current_balance, available_balance, credit_limit,
                        _raw(acct), existing_id,
                    ),
                )
                matched += 1
                action = "repointed"
            else:
                cur.execute(
                    "INSERT INTO accounts ("
                    "user_id, current_item_id, plaid_account_id, persistent_account_id, "
                    "name, official_name, mask, type, subtype, currency, "
                    "current_balance, available_balance, credit_limit, "
                    "balance_last_updated, raw) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), %s)",
                    (
                        user_id, item_id, plaid_account_id, persistent_account_id,
                        name, official_name, mask, type_, subtype, currency,
                        current_balance, available_balance, credit_limit,
                        _raw(acct),
                    ),
                )
                inserted += 1
                action = "inserted"

            summary.append({
                "plaid_account_id": plaid_account_id,
                "name": name,
                "mask": mask,
                "type": type_,
                "subtype": subtype,
                "action": action,
            })

    return {"inserted": inserted, "matched": matched, "accounts": summary}
