"""Read API — Phase 7a, extended by the transaction-semantics layer (0003/0004).

Every endpoint depends on ``require_auth`` and filters ``WHERE user_id = %s`` with
the user_id taken straight from the verified token — single-user today, but this
is exactly what makes the data multi-user-safe for free (a token can only ever
read rows tagged with its own ``sub``). Endpoints read from the ``v_*`` views and
``fn_*`` summary functions, never the raw tables.

Filter rule (design-notes/transaction-semantics/06): new endpoint per response
*shape*, query params per *subset* of the same shape. ``/api/transactions``
grows named filters; ``/api/transfers`` and ``/api/review`` are separate because
their shapes differ (pairs; a work queue).
"""

from __future__ import annotations

import datetime as dt
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query

from .auth import require_auth
from .db import fetch_all

router = APIRouter(prefix="/api", tags=["read"])

# The txn_class taxonomy (0004's CASE). Validated here so a typo'd filter is a
# 422, not an silently-empty result.
TXN_CLASSES = {
    "spending", "income", "refund", "internal_transfer", "saving_investing",
    "debt_payment", "cash", "p2p_unclassified", "transfer_unmatched",
}


@router.get("/accounts")
def list_accounts(user_id: str = Depends(require_auth)) -> dict:
    """The user's accounts — drives the transactions account filter (and later an
    accounts/balances view). Institution name is read through the account's
    current_item_id (provenance, §3). ``effective_name`` is the one canonical
    place the display-name fallback is computed for raw-account consumers (the
    views do their own COALESCE); ordering follows it so the dropdown sorts by
    what the user actually sees."""
    rows = fetch_all(
        "SELECT a.id, a.name, a.display_name, "
        "COALESCE(a.display_name, a.name) AS effective_name, "
        "a.official_name, a.mask, a.type, a.subtype, "
        "a.currency, a.current_balance, a.available_balance, i.institution_name "
        "FROM accounts a JOIN items i ON i.id = a.current_item_id "
        "WHERE a.user_id = %s "
        "ORDER BY a.type NULLS LAST, COALESCE(a.display_name, a.name) NULLS LAST",
        (user_id,),
    )
    return {"accounts": rows}


@router.get("/transactions")
def list_transactions(
    user_id: str = Depends(require_auth),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    account_id: str | None = Query(default=None),
    start_date: dt.date | None = Query(default=None),
    end_date: dt.date | None = Query(default=None),
    txn_class: str | None = Query(default=None),
    category: str | None = Query(default=None),
    pending: bool | None = Query(default=None),
    tag: list[uuid.UUID] | None = Query(default=None, description="Tag id; repeatable (OR semantics)"),
) -> dict:
    """Paginated transaction feed (newest first). All filters compose (AND
    across dimensions; OR within repeated tags)."""
    if txn_class is not None and txn_class not in TXN_CLASSES:
        raise HTTPException(422, f"unknown txn_class (expected one of {sorted(TXN_CLASSES)})")

    where = ["user_id = %s"]
    params: list = [user_id]
    if account_id:
        where.append("account_id = %s")
        params.append(account_id)
    if start_date:
        where.append("date >= %s")
        params.append(start_date)
    if end_date:
        where.append("date <= %s")
        params.append(end_date)
    if txn_class:
        where.append("txn_class = %s")
        params.append(txn_class)
    if category:
        where.append("category = %s")
        params.append(category)
    if pending is not None:
        where.append("pending = %s")
        params.append(pending)
    if tag:
        where.append("tag_ids && %s::uuid[]")
        params.append([str(t) for t in tag])
    clause = " AND ".join(where)

    rows = fetch_all(
        f"SELECT * FROM v_transactions WHERE {clause} "
        "ORDER BY date DESC, datetime DESC NULLS LAST, id "
        "LIMIT %s OFFSET %s",
        (*params, limit, offset),
    )
    # `total` is the full matching count (not this page) so callers can detect
    # newly-synced rows even when the page is capped at `limit`.
    total = fetch_all(
        f"SELECT COUNT(*) AS n FROM v_transactions WHERE {clause}", tuple(params)
    )[0]["n"]
    return {
        "transactions": rows,
        "limit": limit,
        "offset": offset,
        "count": len(rows),
        "total": total,
    }


@router.get("/summary/monthly")
def monthly_summary(
    user_id: str = Depends(require_auth),
    tag: list[uuid.UUID] | None = Query(default=None, description="Tag id; repeatable (OR semantics)"),
) -> dict:
    """Classified cash flow per month (income / spending / debt / saving /
    quarantined p2p), newest first. Optionally scoped to tagged transactions."""
    rows = fetch_all(
        "SELECT * FROM fn_monthly_summary(%s, %s::uuid[]) ORDER BY month DESC",
        (user_id, [str(t) for t in tag] if tag else None),
    )
    return {"months": rows}


@router.get("/summary/category")
def category_summary(
    user_id: str = Depends(require_auth),
    month: dt.date | None = Query(
        default=None, description="First day of the month (YYYY-MM-01) to filter to"
    ),
    tag: list[uuid.UUID] | None = Query(default=None, description="Tag id; repeatable (OR semantics)"),
) -> dict:
    """Net spending by category (refunds offset their category). Optionally
    scoped to a single month and/or tagged transactions; largest first."""
    where = ""
    params: list = [user_id, [str(t) for t in tag] if tag else None]
    if month:
        where = "WHERE month = %s"
        params.append(month)

    rows = fetch_all(
        f"SELECT * FROM fn_category_summary(%s, %s::uuid[]) {where} "
        "ORDER BY month DESC, spending DESC",
        tuple(params),
    )
    return {"categories": rows}


@router.get("/transfers")
def list_transfers(user_id: str = Depends(require_auth)) -> dict:
    """The pair ledger — one row per matched transfer (both legs), newest first."""
    rows = fetch_all(
        "SELECT * FROM v_transfers WHERE user_id = %s "
        "ORDER BY out_date DESC, amount DESC",
        (user_id,),
    )
    return {"transfers": rows}


@router.get("/review")
def review_queue(user_id: str = Depends(require_auth)) -> dict:
    """The review inbox: p2p rows, unmatched transfers, and low-confidence
    categories awaiting a user ruling. Biggest amounts first — resolve the
    material ones first."""
    rows = fetch_all(
        "SELECT * FROM v_needs_review WHERE user_id = %s "
        "ORDER BY abs(amount) DESC, date DESC",
        (user_id,),
    )
    return {"review": rows, "count": len(rows)}


@router.get("/savings-rate")
def savings_rate(user_id: str = Depends(require_auth)) -> dict:
    """Monthly savings rates: explicit (flows into savings/investments) and
    implied (income simply not spent)."""
    rows = fetch_all(
        "SELECT * FROM v_savings_rate WHERE user_id = %s ORDER BY month DESC",
        (user_id,),
    )
    return {"months": rows}


@router.get("/tags")
def list_tags(user_id: str = Depends(require_auth)) -> dict:
    """The tag registry, with usage counts for the picker UI."""
    rows = fetch_all(
        "SELECT t.id, t.name, t.color, count(tt.transaction_id) AS txn_count "
        "FROM tags t LEFT JOIN transaction_tags tt ON tt.tag_id = t.id "
        "WHERE t.user_id = %s "
        "GROUP BY t.id ORDER BY t.name",
        (user_id,),
    )
    return {"tags": rows}
