"""Hand-rolled auth — Phase 7a (replaces the Phase 2 ``current_user_id`` seam).

Three moving parts, per the spec's "Hand-rolled auth" section:

1. **Password verification** — bcrypt-check a submitted password against the
   stored hash (``hash_password`` / ``verify_password``). Never store plaintext.
2. **Token issuance** — on a correct password, mint a signed HS256 JWT carrying
   ``sub`` = user_id and ``exp`` (``create_session_token``). Stateless: the server
   keeps no session table; the signature is what makes the token unforgeable.
3. **Token verification** — ``require_auth`` validates the signature + expiry on
   every protected request and returns the user_id. One dependency, reused by
   every data route. It is the seam that replaced ``current_user_id``.

Invariant (inv. 8): ``jwt.decode`` always pins ``algorithms=["HS256"]`` — never
trust the token's own ``alg`` header (the algorithm-confusion / ``alg:none``
attack). bcrypt cost is 12 (the spec's work factor); ``JWT_SECRET`` comes from
the environment and is never in git.
"""

from __future__ import annotations

import datetime as dt

import bcrypt
import jwt
from fastapi import Depends, Header, HTTPException, Request

from .config import get_settings

JWT_ALG = "HS256"
BCRYPT_ROUNDS = 12
# Short-ish; re-login is cheap for a single-user app and caps token-theft blast
# radius. Mirrors the spec's 12h TTL.
TOKEN_TTL = dt.timedelta(hours=12)

# A fixed, valid bcrypt hash of a throwaway value. Used as the decoy in login when
# the email is unknown, so bcrypt still runs and the response timing does not leak
# whether an account exists (see auth_routes.login). Safe to commit — it is a hash
# of a useless string and matches no real password.
DECOY_PASSWORD_HASH = "$2b$12$cglES0ntn1yuKs6xj7HUC.smvfrjKZDBYB1XmxBWhJEfflMXJY9pC"


def _jwt_secret() -> str:
    secret = get_settings().jwt_secret
    if not secret:
        # Fail loudly rather than mint tokens signed with an empty key.
        raise RuntimeError(
            "JWT_SECRET is not set. Generate one "
            '(python -c "import secrets; print(secrets.token_urlsafe(64))") '
            "and provide it via the environment or backend/.env."
        )
    return secret


def hash_password(plaintext: str) -> str:
    """Return a bcrypt hash (salt embedded) for storage. Used by the CLI only."""
    return bcrypt.hashpw(plaintext.encode("utf-8"), bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode("utf-8")


def verify_password(plaintext: str, password_hash: str) -> bool:
    """Constant-time bcrypt comparison. False (never raises) on a malformed hash.

    A malformed stored hash (e.g. the Phase 2 ``!placeholder...`` sentinel) must
    fail closed, not 500 — so the placeholder account simply cannot log in until
    the set-password CLI writes a real hash.
    """
    try:
        return bcrypt.checkpw(plaintext.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


def create_session_token(user_id: str, *, now: dt.datetime | None = None) -> str:
    """Mint an HS256 session JWT: sub = user_id, with iat/exp. PyJWT enforces exp."""
    issued = now or dt.datetime.now(dt.timezone.utc)
    return jwt.encode(
        {"sub": str(user_id), "iat": issued, "exp": issued + TOKEN_TTL},
        _jwt_secret(),
        algorithm=JWT_ALG,
    )


def require_auth(
    request: Request, authorization: str | None = Header(default=None)
) -> str:
    """FastAPI dependency: return the user_id from a valid bearer token, else 401.

    Replaces the Phase 2 ``current_user_id`` seam — same shape (a dependency
    yielding the user_id), so every route that gated on the seam now gates on a
    real session token without changing its call site. ``user_id`` flows from the
    verified ``sub`` straight into each route's ``WHERE user_id`` filter.

    On success it also stamps ``request.state.user_id`` so the access-log
    middleware can attribute the request without re-decoding the token.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization.split(" ", 1)[1]
    try:
        payload = jwt.decode(
            token,
            _jwt_secret(),
            algorithms=[JWT_ALG],  # inv. 8 — pin the alg; never trust the header
            # Require the claims we always mint: absent-exp would otherwise be
            # treated as "never expires" (PyJWT only validates exp when present).
            options={"require": ["exp", "sub"]},
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="invalid token")

    sub = payload.get("sub")
    if not sub:
        raise HTTPException(status_code=401, detail="invalid token")
    request.state.user_id = str(sub)
    return str(sub)
