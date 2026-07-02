"""FastAPI entrypoint.

Phase 0 health checks, the Phase 2 Plaid Link & item-storage routes, Phase 4
webhooks, and the Phase 7a auth + read API.

Run locally:  uvicorn app.main:app --reload  (from the backend/ directory)
"""

from __future__ import annotations

import logging
import time

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .auth_routes import router as auth_router
from .config import get_settings
from .db import ping
from .logging_setup import configure_logging
from .plaid_routes import router as plaid_router
from .read_routes import router as read_router
from .webhook_routes import router as webhook_router

# Configure logging at import time. uvicorn applies its own log config *before*
# importing this module, so doing it here reliably overrides it with our JSON
# formatter (see logging_setup).
configure_logging()

_request_log = logging.getLogger("app.request")
_error_log = logging.getLogger("app.error")

app = FastAPI(title="Personal Finance API", version="0.0.0")


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Structured access log: method, path, status, latency, and user_id.

    `user_id` is read from `request.state`, which `require_auth` stamps on the
    request after verifying the token — so it lands here for authed routes
    without this middleware re-decoding the JWT (and is null for public ones).
    """
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        # The generic exception handler logs the traceback; here we only emit the
        # access line (status 500) so every request has exactly one, then re-raise.
        duration_ms = round((time.perf_counter() - start) * 1000, 1)
        _request_log.error(
            "request",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status": 500,
                "duration_ms": duration_ms,
                "user_id": getattr(request.state, "user_id", None),
                "client": request.client.host if request.client else None,
            },
        )
        raise
    duration_ms = round((time.perf_counter() - start) * 1000, 1)
    _request_log.info(
        "request",
        extra={
            "method": request.method,
            "path": request.url.path,
            "status": response.status_code,
            "duration_ms": duration_ms,
            "user_id": getattr(request.state, "user_id", None),
            "client": request.client.host if request.client else None,
        },
    )
    return response


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Log any unhandled route error with request context; return a clean 500.

    HTTPException and validation errors have their own handlers and never reach
    here — this only fires for genuinely unexpected failures.
    """
    _error_log.exception(
        "unhandled_exception",
        extra={"method": request.method, "path": request.url.path},
    )
    return JSONResponse(status_code=500, content={"detail": "internal server error"})

# The browser frontend is a separate origin (Phase 8). Allow it to call the API
# with the Authorization bearer header. Credentials aren't cookie-based (the JWT
# rides in a header), so allow_credentials stays False. Webhooks are server→server
# and unaffected by CORS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins_list(),
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(read_router)
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
