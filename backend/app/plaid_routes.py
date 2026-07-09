"""Plaid Link & item-storage endpoints — Phase 2.

Two endpoints implement "first Plaid contact":

* ``POST /link/token/create`` — mint a short-lived ``link_token`` for the browser
  to open Plaid Link. No secret/token leaves the server (invariant 1).
* ``POST /item/public_token/exchange`` — exchange the browser's ``public_token``
  for an ``access_token``, encrypt and store it, then pull the item's accounts
  and run account reconciliation (§3). The ``access_token`` is never returned.

All Plaid I/O happens before the DB transaction is opened, so no connection is
held across network calls. The write (item upsert + account reconcile) is one
transaction via db.connect().
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

import plaid
from plaid.model.accounts_get_request import AccountsGetRequest
from plaid.model.country_code import CountryCode
from plaid.model.institutions_get_by_id_request import InstitutionsGetByIdRequest
from plaid.model.item_get_request import ItemGetRequest
from plaid.model.item_public_token_exchange_request import (
    ItemPublicTokenExchangeRequest,
)
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.link_token_transactions import LinkTokenTransactions
from plaid.model.products import Products
from plaid.model.transactions_refresh_request import TransactionsRefreshRequest

from .auth import require_auth
from .config import get_settings
from .crypto import decrypt_token, encrypt_token
from .db import connect, fetch_all
from .plaid_client import get_plaid_client, plaid_error_detail
from .reconcile import reconcile_accounts
from .sync import LIVE_ITEM_PREDICATE
from .users import refresh_cooldown_remaining

logger = logging.getLogger("app.plaid")

router = APIRouter(tags=["plaid"])

# Products baked into the link token. Transactions is all Phase 3 needs; the
# other four products are added in Phase 5 (broadening may require a re-link).
LINK_PRODUCTS = ["transactions"]

CLIENT_NAME = "Personal Finance Analysis"
COUNTRY_CODES = ["US"]

# Plaid returns only 90 days of history by default; 730 is the maximum. Fixed at
# Item creation (changing it later requires a re-link), so ask for everything up
# front — this is also what makes "re-pull from Plaid" a usable disaster-recovery
# floor for young data.
TXN_DAYS_REQUESTED = 730


def _plaid_error(exc: plaid.ApiException) -> HTTPException:
    """Translate a Plaid ApiException into a 502 carrying Plaid's error fields."""
    detail = plaid_error_detail(exc)
    return HTTPException(
        status_code=502,
        detail={
            "source": "plaid",
            "error_code": detail["error_code"],
            "error_message": detail["error_message"] or "Plaid request failed",
        },
    )


class ExchangeRequest(BaseModel):
    public_token: str


@router.post("/link/token/create")
def create_link_token(
    user_id: str = Depends(require_auth),
) -> dict:
    """Return a link_token the browser uses to open Plaid Link."""
    client = get_plaid_client()
    kwargs = dict(
        user=LinkTokenCreateRequestUser(client_user_id=user_id),
        client_name=CLIENT_NAME,
        products=[Products(p) for p in LINK_PRODUCTS],
        country_codes=[CountryCode(c) for c in COUNTRY_CODES],
        language="en",
        transactions=LinkTokenTransactions(days_requested=TXN_DAYS_REQUESTED),
    )
    # Register the webhook so Plaid POSTs item/transaction updates (Phase 4).
    # Omitted in local dev (no public URL).
    webhook_url = get_settings().plaid_webhook_url
    if webhook_url:
        kwargs["webhook"] = webhook_url
    # OAuth banks (most major US institutions in Production) redirect back to
    # this URI mid-Link; it must also be registered in the Plaid dashboard.
    redirect_uri = get_settings().plaid_redirect_uri
    if redirect_uri:
        kwargs["redirect_uri"] = redirect_uri
    request = LinkTokenCreateRequest(**kwargs)
    try:
        resp = client.link_token_create(request)
    except plaid.ApiException as exc:
        raise _plaid_error(exc)
    return {"link_token": resp["link_token"], "expiration": str(resp["expiration"])}


def _fetch_institution_name(client, institution_id: str | None) -> str | None:
    """Best-effort institution display name; None if lookup fails or absent."""
    if not institution_id:
        return None
    try:
        resp = client.institutions_get_by_id(
            InstitutionsGetByIdRequest(
                institution_id=institution_id,
                country_codes=[CountryCode(c) for c in COUNTRY_CODES],
            )
        )
        return resp["institution"]["name"]
    except plaid.ApiException:
        return None


def _upsert_item(
    conn,
    user_id: str,
    plaid_item_id: str,
    access_token_encrypted: str,
    institution_id: str | None,
    institution_name: str | None,
) -> str:
    """Insert or refresh the items row; return its uuid. Resets health on link."""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO items ("
            "user_id, plaid_item_id, plaid_institution_id, institution_name, "
            "access_token_encrypted, products, status) "
            "VALUES (%s, %s, %s, %s, %s, %s, 'healthy') "
            "ON CONFLICT (plaid_item_id) DO UPDATE SET "
            "access_token_encrypted = EXCLUDED.access_token_encrypted, "
            "plaid_institution_id = EXCLUDED.plaid_institution_id, "
            "institution_name = EXCLUDED.institution_name, "
            "products = EXCLUDED.products, status = 'healthy', "
            "last_error = NULL, retired_at = NULL "
            "RETURNING id",
            (
                user_id, plaid_item_id, institution_id, institution_name,
                access_token_encrypted, LINK_PRODUCTS,
            ),
        )
        return str(cur.fetchone()[0])


@router.post("/item/public_token/exchange")
def exchange_public_token(
    body: ExchangeRequest,
    user_id: str = Depends(require_auth),
) -> dict:
    """Exchange a public_token; store the encrypted access_token + reconcile accounts."""
    client = get_plaid_client()

    # --- All Plaid I/O first (no DB transaction held across network calls) ---
    try:
        exchange = client.item_public_token_exchange(
            ItemPublicTokenExchangeRequest(public_token=body.public_token)
        )
        access_token = exchange["access_token"]
        plaid_item_id = exchange["item_id"]

        item = client.item_get(ItemGetRequest(access_token=access_token))["item"]
        institution_id = item.get("institution_id")

        accounts = client.accounts_get(
            AccountsGetRequest(access_token=access_token)
        )["accounts"]
    except plaid.ApiException as exc:
        raise _plaid_error(exc)

    institution_name = _fetch_institution_name(client, institution_id)
    account_dicts = [a.to_dict() for a in accounts]

    # --- One DB transaction: encrypt-then-store token, then reconcile accounts ---
    access_token_encrypted = encrypt_token(access_token)
    with connect() as conn:
        item_id = _upsert_item(
            conn, user_id, plaid_item_id, access_token_encrypted,
            institution_id, institution_name,
        )
        result = reconcile_accounts(
            conn, user_id, item_id, account_dicts, institution_id
        )

    # Deliberately no access_token in the response (invariant 1).
    return {
        "item_id": item_id,
        "plaid_item_id": plaid_item_id,
        "institution_name": institution_name,
        "accounts_inserted": result["inserted"],
        "accounts_matched": result["matched"],
        "accounts": result["accounts"],
    }


def _request_refreshes(items: list[dict]) -> None:
    """Background task: ask Plaid to re-poll each bank. Per-item failures are
    logged and swallowed — the 202 already went out; results only ever arrive
    via SYNC_UPDATES_AVAILABLE → the webhook sync path."""
    client = get_plaid_client()
    for item in items:
        try:
            client.transactions_refresh(
                TransactionsRefreshRequest(
                    access_token=decrypt_token(item["access_token_encrypted"])
                )
            )
            logger.info("refresh.requested", extra={"item": item["plaid_item_id"]})
        except plaid.ApiException as exc:
            logger.error(
                "refresh.item_failed",
                extra={
                    "item": item["plaid_item_id"],
                    "error_code": plaid_error_detail(exc).get("error_code"),
                },
            )
        except Exception:
            logger.exception(
                "refresh.item_failed", extra={"item": item["plaid_item_id"]}
            )


@router.post("/api/transactions/refresh", status_code=202)
def refresh_transactions(
    background: BackgroundTasks,
    user_id: str = Depends(require_auth),
) -> dict:
    """Ask Plaid to re-poll every linked bank for new transactions (billed per
    call). Fire-and-forget: guards and the atomic cooldown claim run inline;
    the Plaid calls run after the response as a background task, and results
    arrive later via SYNC_UPDATES_AVAILABLE → the webhook sync path. The
    per-user cooldown, claimed atomically BEFORE any Plaid I/O, caps cost —
    concurrent requests can't double-bill. Clients re-read /api/sync-status
    for the cooldown and per-bank freshness."""
    cooldown = get_settings().refresh_cooldown_seconds

    # Guards first, so a request that can't do anything doesn't burn a window.
    items = fetch_all(
        "SELECT plaid_item_id, status, access_token_encrypted FROM items "
        f"WHERE user_id = %s AND {LIVE_ITEM_PREDICATE}",
        (user_id,),
    )
    if not items:
        raise HTTPException(404, "no linked banks to refresh")
    # Refreshing a dead login is a guaranteed per-call charge that fails.
    eligible = [i for i in items if i["status"] not in ("login_required", "revoked")]
    if not eligible:
        raise HTTPException(409, "all linked banks need to be reconnected first")

    # Atomic claim: the guarded UPDATE either wins the window or nobody does —
    # two concurrent requests can both pass the guards above, but only one gets
    # a row back here. Accepted tradeoff: a fully-failed background run still
    # burns one window. The 429 is raised OUTSIDE the connect() block because
    # the remaining-helper opens its own connection.
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET last_manual_refresh_at = now() "
                "WHERE id = %s AND (last_manual_refresh_at IS NULL "
                "  OR last_manual_refresh_at < now() - make_interval(secs => %s)) "
                "RETURNING id",
                (user_id, cooldown),
            )
            claimed = cur.fetchone() is not None
    if not claimed:
        raise HTTPException(
            429,
            detail={
                "message": "Refreshed recently — try again shortly.",
                "retry_after": max(1, refresh_cooldown_remaining(user_id)),
            },
        )

    background.add_task(_request_refreshes, eligible)
    return {"status": "accepted"}
