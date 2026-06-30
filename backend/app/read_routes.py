"""Read API — Phase 7a. Auth-gated endpoints served from the SQL views.

Every endpoint depends on ``require_auth`` and filters ``WHERE user_id = %s`` with
the user_id taken straight from the verified token — single-user today, but this
is exactly what makes the data multi-user-safe for free (a token can only ever
read rows tagged with its own ``sub``). Endpoints read from the ``v_*`` views
(0002), never the raw tables.
"""

from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, Query

from .auth import require_auth
from .db import fetch_all

router = APIRouter(prefix="/api", tags=["read"])


@router.get("/accounts")
def list_accounts(user_id: str = Depends(require_auth)) -> dict:
    """The user's accounts — drives the transactions account filter (and later an
    accounts/balances view). Institution name is read through the account's
    current_item_id (provenance, §3), ordered for a stable dropdown."""
    rows = fetch_all(
        "SELECT a.id, a.name, a.official_name, a.mask, a.type, a.subtype, "
        "a.currency, a.current_balance, a.available_balance, i.institution_name "
        "FROM accounts a JOIN items i ON i.id = a.current_item_id "
        "WHERE a.user_id = %s "
        "ORDER BY a.type NULLS LAST, a.name NULLS LAST",
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
) -> dict:
    """Paginated transaction feed (newest first), with optional account/date filters."""
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
    clause = " AND ".join(where)

    rows = fetch_all(
        f"SELECT * FROM v_transactions WHERE {clause} "
        "ORDER BY date DESC, datetime DESC NULLS LAST, id "
        "LIMIT %s OFFSET %s",
        (*params, limit, offset),
    )
    return {"transactions": rows, "limit": limit, "offset": offset, "count": len(rows)}


@router.get("/summary/monthly")
def monthly_summary(user_id: str = Depends(require_auth)) -> dict:
    """Income / spending / net per month, newest month first."""
    rows = fetch_all(
        "SELECT * FROM v_monthly_summary WHERE user_id = %s ORDER BY month DESC",
        (user_id,),
    )
    return {"months": rows}


@router.get("/summary/category")
def category_summary(
    user_id: str = Depends(require_auth),
    month: dt.date | None = Query(
        default=None, description="First day of the month (YYYY-MM-01) to filter to"
    ),
) -> dict:
    """Spending by category. Optionally scoped to a single month; largest first."""
    where = ["user_id = %s"]
    params: list = [user_id]
    if month:
        where.append("month = %s")
        params.append(month)
    clause = " AND ".join(where)

    rows = fetch_all(
        f"SELECT * FROM v_category_summary WHERE {clause} "
        "ORDER BY month DESC, spending DESC",
        tuple(params),
    )
    return {"categories": rows}
