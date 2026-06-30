"""Thin Postgres access for Phase 0.

A single short-lived connection per call is plenty for the foundations phase
(a health check and the migrator). A real connection pool is introduced when
the sync engine and read API need it (Phase 3+). Backend ↔ Postgres always
goes over the Railway private network via DATABASE_URL.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row

from .config import get_settings


@contextmanager
def connect() -> Iterator[psycopg.Connection]:
    """Yield a single autocommit-off connection; commit/rollback on exit."""
    settings = get_settings()
    conn = psycopg.connect(settings.require_database_url())
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def ping() -> bool:
    """Return True if the database answers SELECT 1."""
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            return cur.fetchone() == (1,)


def fetch_all(sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    """Run a read-only query and return rows as dicts (for JSON read endpoints).

    A fresh short-lived connection per call — same posture as connect(); a pool
    arrives if/when read traffic warrants it. The dict_row factory makes columns
    addressable by name so view shapes map straight to JSON.
    """
    with psycopg.connect(settings_url(), row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()


def settings_url() -> str:
    return get_settings().require_database_url()
