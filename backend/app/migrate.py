"""Plain-SQL migration runner.

The mechanism every later schema and view change rides on (the build plan's
Phase 0 deliverable). Design goals:

* **Plain .sql files, applied in lexical order** from ``db/migrations`` — the
  filename's numeric prefix is the version (e.g. ``0001_initial_schema.sql``).
* **Tracked** in a ``schema_migrations`` table so each file runs exactly once.
* **Idempotent re-runs**: running again when nothing is pending applies nothing
  and exits 0 ("re-running migrations is clean").
* **Per-file transaction**: each migration runs in its own transaction and is
  recorded in the same transaction — a failure rolls the file back cleanly and
  leaves it pending, never half-applied.

Usage (from the backend/ directory, with DATABASE_URL in env or .env):
    python -m app.migrate            # apply all pending migrations
    python -m app.migrate --status   # list applied vs pending, apply nothing
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

import psycopg

from .config import get_settings

# backend/app/migrate.py -> backend/ -> db/migrations. parents[1] (the backend
# dir) is the anchor so this resolves both locally (backend/db/migrations) and in
# the Railway container, where the build context is backend/ copied to /app
# (/app/db/migrations).
MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "db" / "migrations"

CREATE_TRACKING_TABLE = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text        PRIMARY KEY,
    checksum    text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
)
"""


def discover() -> list[Path]:
    """Return migration files sorted by filename (numeric prefix = order)."""
    if not MIGRATIONS_DIR.is_dir():
        raise RuntimeError(f"migrations directory not found: {MIGRATIONS_DIR}")
    return sorted(MIGRATIONS_DIR.glob("*.sql"))


def _checksum(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _applied(conn: psycopg.Connection) -> dict[str, str]:
    with conn.cursor() as cur:
        cur.execute("SELECT version, checksum FROM schema_migrations")
        return {row[0]: row[1] for row in cur.fetchall()}


def status() -> int:
    settings = get_settings()
    files = discover()
    with psycopg.connect(settings.require_database_url()) as conn:
        with conn.cursor() as cur:
            cur.execute(CREATE_TRACKING_TABLE)
        conn.commit()
        applied = _applied(conn)

    for path in files:
        version = path.stem
        if version in applied:
            drift = "" if applied[version] == _checksum(path.read_text()) else "  !! CHECKSUM DRIFT"
            print(f"  applied  {version}{drift}")
        else:
            print(f"  pending  {version}")
    if not files:
        print("  (no migration files found)")
    return 0


def migrate() -> int:
    settings = get_settings()
    files = discover()

    with psycopg.connect(settings.require_database_url()) as conn:
        with conn.cursor() as cur:
            cur.execute(CREATE_TRACKING_TABLE)
        conn.commit()
        applied = _applied(conn)

        pending = [p for p in files if p.stem not in applied]

        # Guard against silently-edited migrations that were already applied.
        for path in files:
            version = path.stem
            if version in applied and applied[version] != _checksum(path.read_text()):
                print(
                    f"ERROR: {version} was already applied but its file changed "
                    f"(checksum drift). Migrations are immutable once applied — "
                    f"add a new migration instead of editing this one.",
                    file=sys.stderr,
                )
                return 1

        if not pending:
            print("Up to date — no pending migrations.")
            return 0

        for path in pending:
            version = path.stem
            sql = path.read_text()
            print(f"Applying {version} ...", end=" ", flush=True)
            try:
                with conn.transaction():
                    with conn.cursor() as cur:
                        cur.execute(sql)
                        cur.execute(
                            "INSERT INTO schema_migrations (version, checksum) "
                            "VALUES (%s, %s)",
                            (version, _checksum(sql)),
                        )
            except Exception as exc:
                print("FAILED")
                print(f"  {version} rolled back: {exc}", file=sys.stderr)
                return 1
            print("ok")

        print(f"Applied {len(pending)} migration(s).")
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply plain-SQL migrations in order.")
    parser.add_argument(
        "--status",
        action="store_true",
        help="show applied/pending migrations and exit without applying",
    )
    args = parser.parse_args()
    return status() if args.status else migrate()


if __name__ == "__main__":
    raise SystemExit(main())
