"""FastAPI entrypoint.

Phase 0 health checks plus the Phase 2 Plaid Link & item-storage routes. Sync,
webhooks, auth, and read endpoints arrive in later phases.

Run locally:  uvicorn app.main:app --reload  (from the backend/ directory)
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from .config import get_settings
from .db import ping
from .plaid_routes import router as plaid_router
from .webhook_routes import router as webhook_router

app = FastAPI(title="Personal Finance API", version="0.0.0")

app.include_router(plaid_router)
app.include_router(webhook_router)


@app.get("/health")
def health() -> dict:
    """Liveness: the process is up. No external dependencies touched."""
    settings = get_settings()
    return {"status": "ok", "environment": settings.environment}


@app.get("/health/db")
def health_db() -> JSONResponse:
    """Readiness: the backend can reach Railway Postgres (DATABASE_URL)."""
    try:
        ok = ping()
    except Exception as exc:  # surface the reason without leaking the URL
        return JSONResponse(
            status_code=503,
            content={"status": "error", "database": "unreachable", "detail": str(exc)},
        )
    return JSONResponse(
        status_code=200 if ok else 503,
        content={"status": "ok" if ok else "error", "database": "reachable"},
    )
