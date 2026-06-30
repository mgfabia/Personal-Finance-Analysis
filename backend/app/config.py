"""Application settings, resolved from environment variables.

Phase 0 decides the *shape* of every secret the app will need, even ones not
used until later phases (the build plan calls for fixing the access-token
encryption key and the JWT secret now). Secrets resolve identically from a
local git-ignored ``.env`` in dev and from Railway env vars in prod.

Nothing here is secret-bearing at rest — the values come from the environment.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Core ---------------------------------------------------------------
    # Railway Postgres private-network URL. In prod this is the private
    # `DATABASE_URL`; in dev it points at the hosted Railway Postgres too
    # (no local DB — see CLAUDE.md). Required for the app and the migrator.
    database_url: str = Field(
        default="",
        validation_alias="DATABASE_URL",
        description="postgresql://user:pass@host:port/dbname",
    )

    environment: str = Field(default="development", validation_alias="ENVIRONMENT")

    # Browser origins allowed to call the API (CORS). The frontend is a separate
    # origin (its own Railway service in prod, localhost:3000 in dev), so the
    # browser preflights cross-origin calls. Comma-separated; defaults to the dev
    # frontend. In prod set CORS_ALLOW_ORIGINS to the deployed frontend URL.
    cors_allow_origins: str = Field(
        default="http://localhost:3000", validation_alias="CORS_ALLOW_ORIGINS"
    )

    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_allow_origins.split(",") if o.strip()]

    # The single app user's email. Until hand-rolled auth lands (Phase 7), this
    # identifies the one `users` row that all data attaches to; Phase 7's login
    # checks a password against that same row. Override per environment.
    app_user_email: str = Field(
        default="owner@localhost", validation_alias="APP_USER_EMAIL"
    )

    # --- Secrets fixed now, used in later phases ----------------------------
    # HS256 session-JWT signing key (hand-rolled auth, Phase 7). Never in git.
    jwt_secret: str = Field(default="", validation_alias="JWT_SECRET")

    # Symmetric key used to encrypt Plaid access_tokens at rest (Phase 2).
    # The DB only ever stores ciphertext; this key lives in env only.
    access_token_enc_key: str = Field(
        default="", validation_alias="ACCESS_TOKEN_ENC_KEY"
    )

    # --- Plaid (Sandbox in dev; used from Phase 2) --------------------------
    plaid_client_id: str = Field(default="", validation_alias="PLAID_CLIENT_ID")
    plaid_secret: str = Field(default="", validation_alias="PLAID_SECRET")
    plaid_env: str = Field(default="sandbox", validation_alias="PLAID_ENV")

    # Public HTTPS URL Plaid POSTs webhooks to (the deployed `/webhooks/plaid`).
    # Passed into link tokens so new items report here. Empty in local dev (no
    # public URL); set to the Railway URL in deployed envs (Phase 4).
    plaid_webhook_url: str = Field(default="", validation_alias="PLAID_WEBHOOK_URL")

    def require_database_url(self) -> str:
        """Fail loudly when a DB operation is attempted without a URL."""
        if not self.database_url:
            raise RuntimeError(
                "DATABASE_URL is not set. Provide it via the environment or a "
                "local .env file (see backend/.env.example)."
            )
        return self.database_url


@lru_cache
def get_settings() -> Settings:
    return Settings()
