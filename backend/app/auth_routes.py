"""Login endpoint — Phase 7a. The app's only unauthenticated write route.

``POST /auth/login``: verify the password against the stored bcrypt hash, and on
success mint a session JWT. The two non-obvious, deliberate properties (spec
§Hand-rolled auth, inv. 8):

* **Identical 401** for unknown-email and wrong-password — never reveal which was
  wrong (account-enumeration defense).
* **bcrypt runs in both branches** — even when the email is unknown we check
  against ``DECOY_PASSWORD_HASH``, so the response time does not leak whether the
  account exists (timing side-channel defense).
* **Global brute-force budget** (see ``rate_limit``) — at most ``LOGIN_MAX_FAILURES``
  failed attempts per ``LOGIN_WINDOW_SECONDS`` across *all* callers, checked before
  any expensive work. bcrypt only throttles offline attacks on a stolen hash; this
  is the online-attack control. The 429 fires before the request body is even
  looked at, so it leaks nothing about email vs password.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .auth import DECOY_PASSWORD_HASH, create_session_token, verify_password
from .db import connect
from .rate_limit import FailureBudget

router = APIRouter(tags=["auth"])

_auth_log = logging.getLogger("app.auth")

# 3 failures per 30 minutes ≈ 144 guesses/day worst case (vs ~14M/day with bcrypt
# as the only throttle). Sized for a single user: the cost of a lockout is one
# person waiting out the window, never a second user's collateral damage.
LOGIN_MAX_FAILURES = 3
LOGIN_WINDOW_SECONDS = 30 * 60

_login_budget = FailureBudget(LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS)


class LoginBody(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


@router.post("/auth/login", response_model=TokenResponse)
def login(body: LoginBody, request: Request) -> TokenResponse:
    # Budget check FIRST — before the DB round-trip and before bcrypt. Once the
    # budget is spent, even the correct password gets a 429 until the window
    # frees: during an active attack the endpoint confirms nothing to anyone.
    retry_after = _login_budget.retry_after()
    if retry_after:
        _auth_log.warning(
            "login throttled",
            extra={"retry_after_s": retry_after, "xff": request.headers.get("x-forwarded-for")},
        )
        raise HTTPException(
            status_code=429,
            detail="too many failed login attempts",
            headers={"Retry-After": str(retry_after)},
        )

    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, password_hash FROM users WHERE email = %s",
                (body.email,),
            )
            row = cur.fetchone()

    # Run bcrypt unconditionally — against the real hash if the user exists, else
    # the decoy — so timing is the same whether or not the email is known.
    stored_hash = row[1] if row else DECOY_PASSWORD_HASH
    password_ok = verify_password(body.password, stored_hash)

    if not row or not password_ok:
        _login_budget.record_failure()
        # X-Forwarded-For is client-influenced, so it informs the *log* (detection),
        # never an enforcement decision. The submitted email is logged to spot
        # enumeration attempts against other addresses.
        _auth_log.warning(
            "login failed",
            extra={"email": body.email, "xff": request.headers.get("x-forwarded-for")},
        )
        # One identical error for both failure modes (never say which was wrong).
        raise HTTPException(status_code=401, detail="invalid credentials")

    _login_budget.record_success()
    _auth_log.info("login succeeded", extra={"user_id": str(row[0])})
    token = create_session_token(str(row[0]))
    return TokenResponse(access_token=token)
