# Personal-Finance-Analysis

Single-user (built scalable) personal-finance web app: links bank accounts via
**Plaid**, syncs five products into **Railway Postgres**, and serves a **Next.js**
UI off a **FastAPI** backend. Replaces an older Raspberry-Pi + dbt + Grafana
system.

> **Source of truth:** [`personal-finance-rebuild-architecture.md`](./personal-finance-rebuild-architecture.md)
> (the locked spec — *what* & *why*) and [`BUILD-PLAN.md`](./BUILD-PLAN.md)
> (phased build order). Read these before changing anything; the spec wins when
> spec and code disagree.

## Status

**Phase 0 — Foundations (scaffolding in place).** Monorepo skeleton, migration
runner, env-driven secrets, FastAPI health checks, Next.js skeleton, and the
backup script all exist. The remaining Phase 0 exit criteria are **manual,
infra-side** steps (provision Railway Postgres, set secrets, run the baseline
migration) — see [Finishing Phase 0](#finishing-phase-0). Phase 1 (the real
schema) is next.

## Layout

```
/backend     FastAPI service + migration runner (app/migrate.py)
  /db        Plain .sql migrations, applied in order  (see backend/db/README.md)
/frontend    Next.js (App Router) — thin skeleton for now
/scripts     Ops: nightly pg_dump backup (backup.sh)
```

## Local development

No local database — dev runs against the hosted Railway Postgres (CLAUDE.md).

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # then fill in DATABASE_URL + secrets

python -m app.migrate           # apply pending migrations (idempotent)
python -m app.migrate --status  # show applied vs pending
uvicorn app.main:app --reload   # http://localhost:8000
```

Health checks: `GET /health` (process up) and `GET /health/db` (reaches
Postgres).

### Frontend

```bash
cd frontend
npm install
cp .env.example .env.local       # NEXT_PUBLIC_API_URL -> backend
npm run dev                      # http://localhost:3000
```

## Secrets

All secrets resolve from the environment (local git-ignored `.env` in dev,
Railway env vars in prod) — never committed. Generate the two fixed now,
used later:

```bash
# JWT_SECRET (hand-rolled auth, Phase 7)
python -c "import secrets; print(secrets.token_urlsafe(64))"
# ACCESS_TOKEN_ENC_KEY (encrypt Plaid access_tokens at rest, Phase 2 — Fernet)
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

## Backups

`scripts/backup.sh` runs `pg_dump` (custom format) and pushes off-Railway via a
`UPLOAD_CMD` hook you provide. Schedule it daily (Railway cron) in prod. Railway
disk is not a backup.

## Finishing Phase 0 (manual / infra)

These are the Phase 0 exit-criteria steps that require accounts and infra and so
can't be scripted here:

1. **Railway project** with two services on the private network: the FastAPI
   backend and a **self-hosted Postgres** container. Copy the private
   `DATABASE_URL` into the backend service env.
2. **Plaid Sandbox** credentials: obtain `PLAID_CLIENT_ID` / `PLAID_SECRET`
   (used from Phase 2) and set them in env.
3. **Set secrets** (`JWT_SECRET`, `ACCESS_TOKEN_ENC_KEY`, `DATABASE_URL`,
   `PLAID_*`) as Railway env vars in prod and in local `.env` for dev.
4. **Apply the baseline migration**: `python -m app.migrate` → `0000_baseline`
   applies cleanly; re-running is a clean no-op. Confirm `GET /health/db` is
   green.
5. **Schedule the nightly backup** (Railway cron → `scripts/backup.sh` with
   `UPLOAD_CMD` pointed at your off-Railway storage).

Exit criteria met when: backend boots and reaches Railway Postgres over the
private network; the empty migration applies cleanly; secrets resolve from env
in both local and Railway.
