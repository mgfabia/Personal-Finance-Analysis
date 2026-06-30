"""One-time CLI to set the single user's login password — Phase 7a.

Phase 2 bootstrapped the ``users`` row with a deliberately unusable
``password_hash`` placeholder (so no one could log in before auth existed). This
command overwrites that placeholder with a real bcrypt hash, **in place** — it
keys on ``APP_USER_EMAIL`` and updates the existing row, so the user's ``id`` is
preserved and every item/account/transaction already attached to it stays
attached. It never inserts a second user.

There is intentionally no signup endpoint — single-user app. You run this once.

Usage (from backend/, with the venv active and DATABASE_URL set):
    python -m app.set_password                 # prompts for the password (hidden)
    python -m app.set_password --password ...  # non-interactive (avoid in shells
                                               # that log history)

The password is read into memory only — never written to disk or echoed; only the
bcrypt hash is stored.
"""

from __future__ import annotations

import argparse
import getpass
import sys

from .auth import hash_password
from .config import get_settings
from .db import connect
from .users import get_or_create_default_user


def set_password(plaintext: str) -> str:
    """Hash and store the password for the APP_USER_EMAIL user; return the email."""
    email = get_settings().app_user_email
    password_hash = hash_password(plaintext)
    with connect() as conn:
        # Ensure the row exists (idempotent — matches the Phase 2 bootstrap), then
        # overwrite the placeholder hash on that same row. user_id is unchanged.
        get_or_create_default_user(conn)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET password_hash = %s WHERE email = %s",
                (password_hash, email),
            )
    return email


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Set the single app user's login password (Phase 7a)."
    )
    parser.add_argument(
        "--password",
        help="the password (omit to be prompted without echo — preferred)",
    )
    args = parser.parse_args()

    plaintext = args.password
    if not plaintext:
        plaintext = getpass.getpass("New password: ")
        if plaintext != getpass.getpass("Confirm password: "):
            print("Passwords did not match.", file=sys.stderr)
            return 1
    if not plaintext:
        print("Password must not be empty.", file=sys.stderr)
        return 1

    email = set_password(plaintext)
    print(f"Password set for {email}. You can now POST /auth/login.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
