"""Structured logging — one configuration, shared by the API and the sync cron.

Railway's observability feature aggregates every service's **stdout/stderr** and
auto-parses JSON log lines into filterable fields (item_id, status, user_id,
duration_ms, …). So the whole job here is: send consistent, structured lines to
stdout. There is no log-shipping vendor and no new dependency — a small
``JsonFormatter`` (below) is all it takes.

``configure_logging()`` is idempotent and is called at import time by
``app.main`` (so it wins over uvicorn's own log config, which is applied *before*
the app module is imported) and at the top of the sync cron's ``main()``. It also
routes uvicorn's loggers through the same formatter and silences uvicorn's
per-request access log, since the request-logging middleware (``app.main``) emits
a richer one (latency + user_id).

Format is env-controlled (``LOG_FORMAT``): ``json`` in deployed envs, ``plain``
for a readable local console.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import logging.config

from .config import get_settings

# Attributes present on every LogRecord by default. Anything *else* attached to a
# record (via ``logger.info(msg, extra={...})``) is treated as a structured field
# and merged into the JSON body. Computed once from a probe record so we never
# hand-maintain the list.
_RESERVED = set(logging.LogRecord("", 0, "", 0, "", None, None).__dict__)
_RESERVED |= {"message", "asctime", "taskName"}


class JsonFormatter(logging.Formatter):
    """Render a LogRecord as a single-line JSON object for Railway to parse."""

    def format(self, record: logging.LogRecord) -> str:
        out: dict = {
            "ts": dt.datetime.fromtimestamp(
                record.created, dt.timezone.utc
            ).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # Merge structured extras (the `extra={...}` kwargs) as top-level fields.
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                out[key] = value
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        if record.stack_info:
            out["stack"] = self.formatStack(record.stack_info)
        return json.dumps(out, default=str)


_PLAIN_FORMAT = "%(asctime)s %(levelname)-7s %(name)s  %(message)s"


def configure_logging() -> None:
    """Install the stdout handler + formatter on the root and uvicorn loggers."""
    settings = get_settings()
    level = settings.log_level.upper()

    if settings.log_format == "plain":
        formatter: dict = {"format": _PLAIN_FORMAT}
    else:
        formatter = {"()": f"{__name__}.JsonFormatter"}

    logging.config.dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {"app": formatter},
            "handlers": {
                "stdout": {
                    "class": "logging.StreamHandler",
                    "stream": "ext://sys.stdout",
                    "formatter": "app",
                }
            },
            "root": {"level": level, "handlers": ["stdout"]},
            "loggers": {
                # uvicorn startup / lifecycle / error lines → our formatter.
                "uvicorn": {"level": level, "handlers": ["stdout"], "propagate": False},
                "uvicorn.error": {
                    "level": level,
                    "handlers": ["stdout"],
                    "propagate": False,
                },
                # Silence uvicorn's own access log — the request middleware emits a
                # richer one (status + duration_ms + user_id). WARNING keeps real
                # access-logger problems visible without the per-request noise.
                "uvicorn.access": {
                    "level": "WARNING",
                    "handlers": ["stdout"],
                    "propagate": False,
                },
            },
        }
    )
