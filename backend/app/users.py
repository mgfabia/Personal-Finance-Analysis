"""The single app user — bootstrap of the one ``users`` row (invariant 6).

Every data row needs a ``user_id``, so we ensure exactly one ``users`` row exists
(keyed by ``APP_USER_EMAIL``). The bootstrap stores a deliberately *unusable*
``password_hash`` placeholder — not a real hash, so it can never match any
password. ``app.set_password`` (Phase 7a) overwrites it with a genuine bcrypt
hash on that same row, preserving the id and all attached data.

The request-time seam that once lived here (``current_user_id``) is gone: Phase 7a
replaced it with real session-JWT verification in ``app.auth.require_auth``, which
every data/write route now depends on. This module is only the bootstrap now —
used by the set-password CLI and the Phase 2 link flow's account attachment.
"""

from __future__ import annotations

import psycopg

from .config import get_settings

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
