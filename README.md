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

**Phases 0–4 complete.** Phase 0 (Foundations) is live on Railway; Phase 1 (the
identity/provenance schema) is migrated; Phase 2 (Plaid Link → encrypted
`access_token` → account reconciliation), Phase 3 (the advisory-locked,
transactional, idempotent transactions sync engine + cron entrypoint
`python -m app.sync`), and Phase 4 (verified webhooks + item health —
`POST /webhooks/plaid` triggers `run_sync`; `ITEM` webhooks/sync-failures
maintain `items.status`). **All of this is deployed to Railway and validated
end-to-end on production** against Plaid Sandbox — migration, health, the interim
`X-API-Key` guard, link → encrypted storage, the nightly `sync-cron` service, and
real Plaid-signed webhook verification (`POST /webhooks/plaid 200`). **Phase 5**
(remaining products) is next. Outstanding infra: nightly `pg_dump` backup; a true
forked `staging` env is deferred until Phase 9 (prod is Sandbox-backed). Real auth
(`JWT_SECRET`, replacing the interim guard) is Phase 7.

## Layout

```
/backend     FastAPI service + migration runner (app/migrate.py)
  /db        Plain .sql migrations, applied in order  (see backend/db/README.md)
/frontend    Next.js (App Router) — thin skeleton for now
/scripts     Ops: nightly pg_dump backup (backup.sh)
```

## Local development

**Each environment has its own database — never shared.** Local dev uses a
disposable Postgres in Docker; deployed environments (staging, production) each
get their own Railway Postgres. Plaid Sandbox is hit over the internet from all of
them.

### The two loops

- **Inner loop (local, fast):** edit → `uvicorn --reload` restarts → hit
  `http://localhost:8000/docs` (FastAPI's interactive API explorer) or `curl` →
  inspect → repeat. No git, no deploy. This is where most work happens.
- **Outer loop (deploy):** push only code that already works locally → Railway
  builds → pre-deploy `migrate` → smoke-test the deployed URL. Git ships proven
  code; it is not how you test.

### Backend

```bash
# 1. Start a local, isolated Postgres (repo root)
docker compose up -d

# 2. Backend deps + env
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # DATABASE_URL already points at the local DB;
                                # add Plaid Sandbox keys + generate secrets

# 3. Apply migrations to the local DB, then run with hot reload
python -m app.migrate           # apply pending migrations (idempotent)
python -m app.migrate --status  # show applied vs pending
uvicorn app.main:app --reload   # http://localhost:8000  (docs at /docs)
```

Reset the local DB anytime (handy while iterating on the schema):

```bash
docker compose down -v && docker compose up -d   # wipe + fresh; re-run migrate
```

Health checks: `GET /health` (process up) and `GET /health/db` (reaches
Postgres). Inspect the DB with `psql postgresql://pfa:pfa@localhost:5432/pfa` or
any GUI (TablePlus, DBeaver, pgAdmin).

### Deployed environment isolation (Railway)

- Production is its own environment with a private Postgres.
- Create a **staging** env: Railway → Environments → **New → Fork from
  Production**. Railway clones the service definitions but **not** the data — each
  env gets a fresh Postgres, and `${{Postgres.DATABASE_URL}}` re-resolves per env.
- Optional: enable **Branch Deployments** for ephemeral per-PR environments (own
  URL + own DB, auto-deleted on merge).

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

## License

[MIT](./LICENSE) — use, copy, modify, and redistribute freely; attribution required, no warranty.
