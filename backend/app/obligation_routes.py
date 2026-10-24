"""Recurring obligations — 0007. User-declared monthly commitments (rent, ...).

* ``GET /api/obligations`` — every obligation with its month-by-month events:
  the matched payment, the reimbursements, net, and a status.
* ``POST`` / ``PATCH`` / ``DELETE /api/obligations[/{id}]`` — manage them.

Every write re-runs the matcher inline (same posture as override writes in
write_routes): the response, and the next read, reflect the new grouping.
"""

from __future__ import annotations

import calendar
import datetime as dt
import uuid
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

from .auth import require_auth
from .db import connect, fetch_all
from .derive import rebuild_matches

router = APIRouter(prefix="/api", tags=["obligations"])

# Columns written from ObligationBody, in a fixed order for INSERT/UPDATE.
_COLS = (
    "name", "category", "account_id", "match_text", "amount", "amount_tolerance",
    "day_of_month", "day_window", "reimbursement_amount", "reimbursement_count",
    "reimbursement_tolerance", "start_month", "end_month", "active",
)

# How many months of history the list returns per obligation.
_MAX_PERIODS = 24


class ObligationBody(BaseModel):
    """The full obligation. PATCH merges its keys onto the stored row and
    re-validates the result through this model — one validation path."""
    name: str
    category: str
    account_id: uuid.UUID | None = None
    match_text: str | None = None
    amount: Decimal = Field(gt=0)
    amount_tolerance: Decimal = Field(default=Decimal(0), ge=0)
    day_of_month: int = Field(ge=1, le=31)
    day_window: int = Field(default=5, ge=0, le=10)
    reimbursement_amount: Decimal | None = Field(default=None, gt=0)
    reimbursement_count: int = Field(default=0, ge=0, le=20)
    reimbursement_tolerance: Decimal = Field(default=Decimal(0), ge=0)
    start_month: dt.date | None = None
    end_month: dt.date | None = None
    active: bool = True

    @field_validator("name", "category")
    @classmethod
    def _required_text(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("must be non-empty")
        return v.strip()

    @field_validator("match_text")
    @classmethod
    def _optional_text(cls, v: str | None) -> str | None:
        return (v or "").strip() or None

    @field_validator("start_month", "end_month")
    @classmethod
    def _first_of_month(cls, v: dt.date | None) -> dt.date | None:
        return v.replace(day=1) if v else None

    @model_validator(mode="after")
    def _consistent(self) -> "ObligationBody":
        if (self.reimbursement_count == 0) != (self.reimbursement_amount is None):
            raise ValueError(
                "reimbursement_amount and reimbursement_count go together "
                "(both set, or count 0 and no amount)"
            )
        if self.start_month and self.end_month and self.end_month < self.start_month:
            raise ValueError("end_month must not be before start_month")
        return self


class ObligationPatch(BaseModel):
    """Partial update: only keys present in the request are merged."""
    name: str | None = None
    category: str | None = None
    account_id: uuid.UUID | None = None
    match_text: str | None = None
    amount: Decimal | None = None
    amount_tolerance: Decimal | None = None
    day_of_month: int | None = None
    day_window: int | None = None
    reimbursement_amount: Decimal | None = None
    reimbursement_count: int | None = None
    reimbursement_tolerance: Decimal | None = None
    start_month: dt.date | None = None
    end_month: dt.date | None = None
    active: bool | None = None


def _require_account(cur, account_id: uuid.UUID | None, user_id: str) -> None:
    if account_id is None:
        return
    cur.execute(
        "SELECT 1 FROM accounts WHERE id = %s AND user_id = %s", (account_id, user_id)
    )
    if cur.fetchone() is None:
        raise HTTPException(404, "account not found")


def _expected_date(period: dt.date, day: int) -> dt.date:
    last = calendar.monthrange(period.year, period.month)[1]
    return period.replace(day=min(day, last))


def _add_months(d: dt.date, n: int) -> dt.date:
    y, m = divmod(d.month - 1 + n, 12)
    return dt.date(d.year + y, m + 1, 1)


def _periods(ob: dict[str, Any], matches: list[dict[str, Any]], today: dt.date) -> list[dict]:
    """Month-by-month events, newest first. A month runs from the obligation's
    start (else its first matched month) to its end (else this month — or next
    month when that payment already posted early)."""
    by_period: dict[dt.date, list[dict]] = {}
    for m in matches:
        by_period.setdefault(m["period"], []).append(m)

    this_month = today.replace(day=1)
    first = ob["start_month"] or min(by_period, default=this_month)
    last = max([this_month, *by_period])
    if ob["end_month"]:
        last = min(last, ob["end_month"])

    out = []
    period = last
    while period >= first and len(out) < _MAX_PERIODS:
        rows = by_period.get(period, [])
        payment = next((r for r in rows if r["role"] == "payment"), None)
        reimbursements = [r for r in rows if r["role"] == "reimbursement"]
        shares = sum(r["shares"] for r in reimbursements)
        reimbursed = sum((-r["amount"] for r in reimbursements), Decimal(0))
        expected = _expected_date(period, ob["day_of_month"])
        still_open = today <= expected + dt.timedelta(days=ob["day_window"])

        if payment and shares >= ob["reimbursement_count"]:
            status = "complete"
        elif still_open:
            status = "upcoming"
        elif payment or reimbursements:
            status = "partial"
        else:
            status = "missing"

        out.append({
            "period": period,
            "expected_date": expected,
            "status": status,
            "payment": payment and {
                "transaction_id": payment["transaction_id"],
                "date": payment["date"],
                "amount": payment["amount"],
            },
            "reimbursements": [
                {
                    "transaction_id": r["transaction_id"],
                    "date": r["date"],
                    "amount": r["amount"],
                    "shares": r["shares"],
                }
                for r in reimbursements
            ],
            "shares_received": shares,
            "reimbursed": reimbursed,
            "net": (payment["amount"] if payment else Decimal(0)) - reimbursed,
        })
        period = _add_months(period, -1)
    return out


@router.get("/obligations")
def list_obligations(user_id: str = Depends(require_auth)) -> dict:
    obligations = fetch_all(
        "SELECT ob.*, COALESCE(a.display_name, a.name) AS account_name, "
        "a.mask AS account_mask "
        "FROM obligations ob LEFT JOIN accounts a ON a.id = ob.account_id "
        "WHERE ob.user_id = %s ORDER BY ob.active DESC, ob.name",
        (user_id,),
    )
    matches = fetch_all(
        "SELECT om.obligation_id, om.period, om.role, om.shares, "
        "t.id AS transaction_id, t.date, t.amount "
        "FROM obligation_matches om JOIN transactions t ON t.id = om.transaction_id "
        "WHERE om.user_id = %s AND t.removed_at IS NULL ORDER BY t.date",
        (user_id,),
    )
    by_ob: dict[Any, list[dict]] = {}
    for m in matches:
        by_ob.setdefault(m["obligation_id"], []).append(m)

    today = dt.date.today()
    for ob in obligations:
        ob["periods"] = _periods(ob, by_ob.get(ob["id"], []), today)
        ob.pop("user_id", None)
    return {"obligations": obligations}


def _write(user_id: str, body: ObligationBody, obligation_id: uuid.UUID | None) -> str:
    values = [getattr(body, c) for c in _COLS]
    with connect() as conn:
        with conn.cursor() as cur:
            _require_account(cur, body.account_id, user_id)
            if obligation_id is None:
                cur.execute(
                    f"INSERT INTO obligations (user_id, {', '.join(_COLS)}) "
                    f"VALUES (%s, {', '.join(['%s'] * len(_COLS))}) RETURNING id",
                    (user_id, *values),
                )
            else:
                cur.execute(
                    f"UPDATE obligations SET {', '.join(f'{c} = %s' for c in _COLS)} "
                    "WHERE id = %s AND user_id = %s RETURNING id",
                    (*values, obligation_id, user_id),
                )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "obligation not found")
        rebuild_matches(conn)
    return str(row[0])


@router.post("/obligations", status_code=201)
def create_obligation(body: ObligationBody, user_id: str = Depends(require_auth)) -> dict:
    return {"id": _write(user_id, body, None)}


@router.patch("/obligations/{obligation_id}")
def update_obligation(
    obligation_id: uuid.UUID, body: ObligationPatch, user_id: str = Depends(require_auth)
) -> dict:
    if not body.model_fields_set:
        raise HTTPException(422, "no obligation fields provided")
    rows = fetch_all(
        f"SELECT {', '.join(_COLS)} FROM obligations WHERE id = %s AND user_id = %s",
        (obligation_id, user_id),
    )
    if not rows:
        raise HTTPException(404, "obligation not found")
    merged = {**rows[0], **body.model_dump(include=body.model_fields_set)}
    try:
        full = ObligationBody(**merged)
    except ValueError as exc:  # pydantic ValidationError subclasses ValueError
        raise HTTPException(422, str(exc)) from exc
    return {"id": _write(user_id, full, obligation_id)}


@router.delete("/obligations/{obligation_id}")
def delete_obligation(obligation_id: uuid.UUID, user_id: str = Depends(require_auth)) -> dict:
    """Deletes the obligation; its matches cascade, and the rows fall back to
    their rule-based class (Venmo rows return to the review queue)."""
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM obligations WHERE id = %s AND user_id = %s",
                (obligation_id, user_id),
            )
            if cur.rowcount == 0:
                raise HTTPException(404, "obligation not found")
        rebuild_matches(conn)
    return {"deleted": str(obligation_id)}
