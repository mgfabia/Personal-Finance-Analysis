"""Login endpoint — Phase 7a. The app's only unauthenticated write route.

``POST /auth/login``: verify the password against the stored bcrypt hash, and on
success mint a session JWT. The two non-obvious, deliberate properties (spec
§Hand-rolled auth, inv. 8):

* **Identical 401** for unknown-email and wrong-password — never reveal which was
  wrong (account-enumeration defense).
* **bcrypt runs in both branches** — even when the email is unknown we check
  against ``DECOY_PASSWORD_HASH``, so the response time does not leak whether the
  account exists (timing side-channel defense).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .auth import DECOY_PASSWORD_HASH, create_session_token, verify_password
from .db import connect

router = APIRouter(tags=["auth"])


class LoginBody(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


@router.post("/auth/login", response_model=TokenResponse)
def login(body: LoginBody) -> TokenResponse:
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
        # One identical error for both failure modes (never say which was wrong).
        raise HTTPException(status_code=401, detail="invalid credentials")

    token = create_session_token(str(row[0]))
    return TokenResponse(access_token=token)
