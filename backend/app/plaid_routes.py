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

import json

from fastapi import APIRouter, Depends, HTTPException
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
from plaid.model.products import Products

from .config import get_settings
from .crypto import encrypt_token
from .db import connect
from .plaid_client import get_plaid_client
from .reconcile import reconcile_accounts
from .users import current_user_id

router = APIRouter(tags=["plaid"])

# Products baked into the link token. Transactions is all Phase 3 needs; the
# other four products are added in Phase 5 (broadening may require a re-link).
LINK_PRODUCTS = ["transactions"]

CLIENT_NAME = "Personal Finance Analysis"
COUNTRY_CODES = ["US"]


def _plaid_error(exc: plaid.ApiException) -> HTTPException:
    """Translate a Plaid ApiException into a 502 carrying Plaid's error fields."""
    code = message = None
    try:
        body = json.loads(exc.body)
        code = body.get("error_code")
        message = body.get("error_message")
    except (ValueError, TypeError, AttributeError):
        pass
    return HTTPException(
        status_code=502,
        detail={
            "source": "plaid",
            "error_code": code,
            "error_message": message or "Plaid request failed",
        },
    )


class ExchangeRequest(BaseModel):
    public_token: str


@router.post("/link/token/create")
def create_link_token(user_id: str = Depends(current_user_id)) -> dict:
    """Return a link_token the browser uses to open Plaid Link."""
    client = get_plaid_client()
    kwargs = dict(
        user=LinkTokenCreateRequestUser(client_user_id=user_id),
        client_name=CLIENT_NAME,
        products=[Products(p) for p in LINK_PRODUCTS],
        country_codes=[CountryCode(c) for c in COUNTRY_CODES],
        language="en",
    )
    # Register the webhook so Plaid POSTs item/transaction updates (Phase 4).
    # Omitted in local dev (no public URL).
    webhook_url = get_settings().plaid_webhook_url
    if webhook_url:
        kwargs["webhook"] = webhook_url
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
    body: ExchangeRequest, user_id: str = Depends(current_user_id)
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
        result = reconcile_accounts(conn, user_id, item_id, account_dicts)

    # Deliberately no access_token in the response (invariant 1).
    return {
        "item_id": item_id,
        "plaid_item_id": plaid_item_id,
        "institution_name": institution_name,
        "accounts_inserted": result["inserted"],
        "accounts_matched": result["matched"],
        "accounts": result["accounts"],
    }
