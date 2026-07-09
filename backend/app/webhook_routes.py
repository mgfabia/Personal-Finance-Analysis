"""Plaid webhook endpoint — Phase 4.

A single thin handler (§Webhook requirements 3): verify → record what changed →
return 200 immediately → do slow work (a sync) in a background task. Plaid
retries on timeout, so a full sync is never run inline.

Two branches (§Item health):
  * ``TRANSACTIONS / SYNC_UPDATES_AVAILABLE`` → trigger ``run_sync`` for the item
    (in the background). The advisory lock inside ``run_sync`` makes this safe
    against a concurrent cron run on the same item.
  * ``ITEM`` webhooks (login-required, pending-expiration, revoked, error) →
    update ``items.status`` / ``last_error`` so the reconnect UI (Phase 8) can
    surface it. A fast DB write, done inline.

Verification needs the *raw* body (for the SHA-256 claim), so we read
``request.body()`` and parse JSON ourselves rather than via a Pydantic model.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from .db import connect
from .derive import rebuild as rebuild_derived
from .sync import _record_error, fetch_item, run_sync
from .webhooks import verify_webhook

router = APIRouter(tags=["webhooks"])
logger = logging.getLogger("app.webhook")

# ITEM webhook_code → items.status. Codes not listed (e.g. NEW_ACCOUNTS_AVAILABLE,
# WEBHOOK_UPDATE_ACKNOWLEDGED) don't change health and are recorded but ignored.
_ITEM_STATUS = {
    "ITEM_LOGIN_REQUIRED": "login_required",
    "PENDING_EXPIRATION": "pending_expiration",
    "USER_PERMISSION_REVOKED": "revoked",
    "USER_ACCOUNT_REVOKED": "revoked",
}


def _run_sync_for_item(plaid_item_id: str) -> None:
    """Background task: sync one item, isolating/recording any failure."""
    item = fetch_item(plaid_item_id)
    if item is None:
        logger.warning("webhook.sync_unknown_item", extra={"item": plaid_item_id})
        return  # unknown or retired item — nothing to do
    try:
        result = run_sync(item)
        logger.info("webhook.sync", extra=result)
    except Exception as exc:
        _record_error(item, exc)
        logger.exception(
            "webhook.sync_failed", extra={"item": plaid_item_id, "status": "error"}
        )
        return
    # Re-derive transfer pairing after a successful sync (same posture as the
    # cron tail: stale-on-failure, never blocks the sync).
    try:
        rebuild_derived()
    except Exception:
        logger.exception("webhook.derive_failed", extra={"item": plaid_item_id})


def _apply_item_webhook(webhook_code: str, plaid_item_id: str, payload: dict) -> None:
    """Update items.status / last_error from an ITEM webhook (fast, inline)."""
    error = payload.get("error")
    # An ERROR webhook carries the real condition in its error_code.
    status = _ITEM_STATUS.get(webhook_code)
    if status is None and webhook_code == "ERROR" and isinstance(error, dict):
        status = _ITEM_STATUS.get(error.get("error_code"))

    sets = ["last_error = %s"]
    params: list[Any] = [json.dumps(error) if error is not None else None]
    if status is not None:
        sets.insert(0, "status = %s")
        params.insert(0, status)
    params.append(plaid_item_id)

    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE items SET {', '.join(sets)} "
                "WHERE plaid_item_id = %s AND retired_at IS NULL",
                params,
            )


def handle_webhook(payload: dict, background: BackgroundTasks) -> None:
    """Route a verified webhook to the right branch."""
    wtype = payload.get("webhook_type")
    wcode = payload.get("webhook_code")
    plaid_item_id = payload.get("item_id")
    if not plaid_item_id:
        return

    if wtype == "TRANSACTIONS" and wcode == "SYNC_UPDATES_AVAILABLE":
        background.add_task(_run_sync_for_item, plaid_item_id)
    elif wtype == "ITEM":
        _apply_item_webhook(wcode, plaid_item_id, payload)
    # Other product webhooks (RECURRING/HOLDINGS/LIABILITIES) arrive in Phase 5.


@router.post("/webhooks/plaid")
async def plaid_webhook(request: Request, background: BackgroundTasks) -> dict:
    raw = await request.body()
    reason = verify_webhook(raw, request.headers.get("plaid-verification"))
    if reason is not None:
        logger.warning(
            "webhook.verify_failed",
            extra={
                "reason": reason,
                "client": request.client.host if request.client else None,
            },
        )
        raise HTTPException(status_code=401, detail="webhook verification failed")
    try:
        payload = json.loads(raw or b"{}")
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid JSON body")

    logger.info(
        "webhook.received",
        extra={
            "webhook_type": payload.get("webhook_type"),
            "webhook_code": payload.get("webhook_code"),
            "item": payload.get("item_id"),
        },
    )
    handle_webhook(payload, background)
    return {"status": "received"}  # 200 fast; work continues in the background
