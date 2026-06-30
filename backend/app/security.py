"""Interim endpoint guard — bridges the gap until hand-rolled auth (Phase 7).

The Plaid write endpoints (`/link/token/create`, `/item/public_token/exchange`)
have no real auth until Phase 7's `require_auth`. Once a deployed environment has
live Plaid keys, those endpoints are publicly callable — so this dependency gates
them with a shared secret (`API_SHARED_SECRET`) sent in the ``X-API-Key`` header.

Behaviour:
  * Secret configured  → require a constant-time-matching ``X-API-Key`` (401 else).
  * Secret unset + ENVIRONMENT=development → open (no friction for local dev).
  * Secret unset + any deployed environment → **fail closed** (503), so a deploy
    that forgets to set the secret locks the endpoints rather than exposing them.

Phase 7 replaces this dependency with `require_auth` (session-JWT) on the same
routes; the call sites don't change.
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException

from .config import get_settings


def require_api_key(x_api_key: str | None = Header(default=None, alias="X-API-Key")) -> None:
    settings = get_settings()
    secret = settings.api_shared_secret

    if not secret:
        if settings.environment == "development":
            return  # local dev convenience — guard is opt-in via the secret
        raise HTTPException(
            status_code=503,
            detail="endpoint locked: API_SHARED_SECRET is not configured",
        )

    if not x_api_key or not hmac.compare_digest(x_api_key, secret):
        raise HTTPException(status_code=401, detail="invalid or missing API key")
