"""Plaid API client factory.

Builds the official ``plaid-python`` client from ``PLAID_*`` env. The Plaid
secret lives only here (server-side) — it is never sent to the browser
(invariant 1). All Plaid data-endpoint calls go through the client this returns.

``PLAID_ENV`` selects the host: ``sandbox`` for every build phase, ``production``
only at the Phase 9 cutover. (The SDK dropped the old ``development`` host.)
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

import plaid
from plaid.api import plaid_api

from .config import get_settings

_HOSTS = {
    "sandbox": plaid.Environment.Sandbox,
    "production": plaid.Environment.Production,
}


@lru_cache
def get_plaid_client() -> plaid_api.PlaidApi:
    """Return a configured PlaidApi client (cached for the process lifetime)."""
    settings = get_settings()

    if not settings.plaid_client_id or not settings.plaid_secret:
        raise RuntimeError(
            "PLAID_CLIENT_ID / PLAID_SECRET are not set. Provide Sandbox "
            "credentials via the environment (see backend/.env.example)."
        )

    host = _HOSTS.get(settings.plaid_env.lower())
    if host is None:
        raise RuntimeError(
            f"PLAID_ENV={settings.plaid_env!r} is invalid; expected 'sandbox' "
            f"or 'production'."
        )

    configuration = plaid.Configuration(
        host=host,
        api_key={
            "clientId": settings.plaid_client_id,
            "secret": settings.plaid_secret,
        },
    )
    return plaid_api.PlaidApi(plaid.ApiClient(configuration))


def plaid_error_detail(exc: plaid.ApiException) -> dict[str, Any]:
    """Parse a Plaid ApiException body into {error_code, error_message}."""
    try:
        body = json.loads(exc.body)
        return {
            "error_code": body.get("error_code"),
            "error_message": body.get("error_message"),
        }
    except (ValueError, TypeError, AttributeError):
        return {"error_code": None, "error_message": str(exc)}
