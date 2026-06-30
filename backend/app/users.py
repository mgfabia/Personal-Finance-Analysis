"""The single app user — Phase 2 stand-in for hand-rolled auth (Phase 7).

There is no login yet, but every data row needs a ``user_id`` (invariant 6). So
we ensure exactly one ``users`` row exists (keyed by ``APP_USER_EMAIL``) and hand
its id to the write endpoints.

``current_user_id`` is the seam: it is a FastAPI dependency today that returns the
single user's id, and in Phase 7 its body is replaced by JWT verification
(``require_auth``) without the call sites changing.

The bootstrap stores a deliberately *unusable* ``password_hash`` placeholder —
not a real hash, so it can never match any password. Phase 7's "set password"
step overwrites it with a genuine bcrypt hash.
"""

from __future__ import annotations

import psycopg

from .config import get_settings
from .db import connect

# Not a valid bcrypt hash ($2b$...): bcrypt verification can never match it, so
# the bootstrapped account is unusable for login until Phase 7 sets a real hash.
_UNUSABLE_PASSWORD_HASH = "!placeholder-no-login-until-phase-7!"


def get_or_create_default_user(conn: psycopg.Connection) -> str:
    """Return the single user's id, inserting the row on first call.

    Idempotent and concurrency-safe via ON CONFLICT on the unique email.
    """
    email = get_settings().app_user_email
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) "
            "ON CONFLICT (email) DO NOTHING",
            (email, _UNUSABLE_PASSWORD_HASH),
        )
        cur.execute("SELECT id FROM users WHERE email = %s", (email,))
        row = cur.fetchone()
    return str(row[0])


def current_user_id() -> str:
    """FastAPI dependency: the authenticated user's id.

    Phase 2 stand-in — resolves the single bootstrapped user. Phase 7 swaps this
    body for session-JWT verification; the dependency signature stays the same so
    every route that depends on it is unaffected.
    """
    with connect() as conn:
        return get_or_create_default_user(conn)
