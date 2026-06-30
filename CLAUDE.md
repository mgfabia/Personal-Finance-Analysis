# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**Phase 0 (Foundations) — complete and deployed.** The backend is live on
Railway (Railpack build) with a self-hosted Postgres on the private network;
`/health` and `/health/db` are green; the migration runner applied
`0000_baseline` via the pre-deploy step. Migrations live in `backend/db` and
auto-apply on every deploy. All Phase 0 exit criteria are met.

**Phase 1 (Data model) — complete.** Identity/provenance schema in
`backend/db/migrations/0001_initial_schema.sql` (applies clean, re-run is a
no-op). FKs encode "account = identity, item = provenance" (`transactions` key
to `accounts`, no `item_id`; `accounts.current_item_id` → `items`;
`persistent_account_id` partial-unique anchor); every data table carries
`user_id` → `users.id`.

**Phase 2 (Link flow & item storage) — complete.** `POST /link/token/create`
and `POST /item/public_token/exchange` (`app/plaid_routes.py`); the
`access_token` is Fernet-encrypted at rest (`app/crypto.py`) and never returned;
exchange runs account reconciliation (`app/reconcile.py`, §3 — match on
`persistent_account_id` → `plaid_account_id` → `(mask,type,subtype,name)`,
re-point `current_item_id`). The single user is bootstrapped via
`app/users.py`'s `current_user_id()` — the seam `require_auth` replaces in
Phase 7. Verified end-to-end against Plaid Sandbox.

**Phase 3 (Transactions sync engine) — complete.** `app/sync.py`: `run_sync`
takes `pg_try_advisory_lock(hashtext(plaid_item_id))` (§1) before any Plaid I/O,
drains `/transactions/sync`, then in one transaction upserts added+modified →
tombstones removed (`removed_at`) → writes `transactions_cursor` **strictly
last** (§2). Idempotent; failure mode is reprocess-never-skip. The nightly cron
entrypoint is `python -m app.sync` (`sync_all_items`). All §1/§2 properties
verified (lock-skip, atomic rollback with cursor un-advanced, tombstone
round-trip).

**Phase 4 (Webhooks & item health) — complete (code; full delivery validates on
deploy).** `app/webhooks.py` verifies every webhook — ES256 with
`algorithms=["ES256"]` pinned (alg-confusion defense), `kid`→key via
`/webhook_verification_key/get` (cached, rejects expired), `request_body_sha256`
matched against the raw body (constant-time), and `iat` freshness. `POST
/webhooks/plaid` (`app/webhook_routes.py`) is the thin handler: verify → branch
→ `200` fast, with `run_sync` in a `BackgroundTasks` (never inline).
`SYNC_UPDATES_AVAILABLE` → background sync; `ITEM` webhooks → `items.status`
(login_required / pending_expiration / revoked). Sync-failure safety net in
`run_sync`: `ITEM_LOGIN_REQUIRED` mid-sync flips `status`, cursor untouched.
**Deployed to production and validated end-to-end** (2026-06-30) — Phases 0–4 are
live on Railway against Plaid Sandbox. Confirmed on prod: migration applied,
health green, the interim `X-API-Key` guard, link → encrypted storage, the cron
syncing real transactions, and **real Plaid-signed webhooks passing verification**
(many `POST /webhooks/plaid 200`). Deployment topology (backend / Postgres /
sync-cron services, the private DB, the guard) is in the memory file
`prod-deployment-topology.md`.

Outstanding follow-ups (none block Phase 5):
- Nightly `pg_dump` backup not yet scheduled (Railway cron + off-Railway
  `UPLOAD_CMD`).
- `JWT_SECRET` deferred to Phase 7 (replaces the interim `X-API-Key` guard).
- A true forked `staging` env is deferred until there's real data to protect
  (closer to Phase 9); today prod is Sandbox-backed.

**Phase 5** (Remaining products — balances, recurring, investments, liabilities,
the same lock-and-upsert shape under the proven engine) is the active phase.

Build order is defined in `BUILD-PLAN.md` (Phase 0 → throwaway Phase S walking
skeleton → correctness phases 1–9).

## Commands

Local dev runs against a **local Postgres in Docker** (`docker compose up -d`),
with `DATABASE_URL` in a git-ignored `backend/.env`. Deployed environments use
their own Railway Postgres (`${{Postgres.DATABASE_URL}}`).

**Backend** (from `/backend`):
- Install: `python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`
- Migrate: `python -m app.migrate` (apply pending) / `python -m app.migrate --status`
- Run: `uvicorn app.main:app --reload` → `GET /health`, `GET /health/db`
- Sync (cron entrypoint): `python -m app.sync` — runs `run_sync` over every live
  item (advisory-locked, transactional, idempotent). This is what the Railway
  nightly cron invokes.

**Frontend** (from `/frontend`): `npm install` then `npm run dev` (build: `npm run build`).

**Backups:** `DATABASE_URL=... ./scripts/backup.sh` (set `UPLOAD_CMD` for off-Railway push).

There are no test or lint commands yet; add them here when introduced.

## Source of truth

Two documents define the project; read them before designing or building anything:

- **`personal-finance-rebuild-architecture.md`** — the locked spec. *What* is being
  built and *why*. The `# Revision — review fixes` section near the bottom
  (concurrency, sync correctness, item identity, reconnect) overrides earlier text
  where they conflict — it is the v1 must-fix set. The final `# Hand-rolled auth`
  section is load-bearing (it replaces Supabase Auth, the one component the
  Railway-only decision adds) and is written to be built from directly.
- **`BUILD-PLAN.md`** — the phased build order (Phases 0–9) and the reasoning for the
  sequence. Use it to know what phase a task belongs to and what it depends on.

When the spec and code disagree, the spec wins until a deliberate decision changes it.

## What this app is

A single-user (built scalable) personal-finance web app that links bank accounts via
**Plaid**, syncs five products (Transactions, Balances, Recurring, Investments,
Liabilities) into Postgres, and serves a web UI. Replaces an older Raspberry-Pi +
dbt + Grafana system.

## Locked stack (do not re-litigate without explicit user sign-off)

- **Backend + worker:** Python / FastAPI on **Railway** (one always-on service +
  native cron). The webhook handler and the scheduled sync worker share this one
  codebase/deploy — they are *not* separate services.
- **Database:** **Railway Postgres** — a self-hosted Postgres container in the same
  Railway project as the backend, on the private network (`DATABASE_URL`). Treated
  as plain managed-by-me Postgres: no auto-REST layer, no edge functions. I own
  backups (nightly `pg_dump` off Railway) and config.
- **Auth:** **hand-rolled** (single-user) — bcrypt password hash + self-signed
  HS256 session JWT + a `require_auth` dependency on every route. There is no
  Supabase Auth. `user_id` is a plain owned column referencing a local `users`
  table. See the spec's "Hand-rolled auth" section.
- **Frontend:** **Next.js** (React) with `react-plaid-link` and a hand-rolled
  sign-in (POST `/auth/login` → store JWT → `Authorization: Bearer` on calls).
  *Hosting target is still open — Vercel vs Railway; see spec §Remaining open
  decisions.*
- **Repo layout:** monorepo — `/backend` (FastAPI; plain SQL migrations live in
  `backend/db`), `/frontend` (Next.js), `/scripts` (ops). *Migrations sit under
  `backend/` (not a top-level `/db`) so they ship inside the backend service's
  Railway build context — the backend's migration runner is their only consumer.*
- **Dev environment:** hosted Plaid **Sandbox** for all phases; Production cutover
  is the last phase. **DB isolation per environment (no shared Postgres):**
  - *Local inner loop:* a local Postgres in Docker (repo-root `docker-compose.yml`)
    with the app run on-host via `uvicorn --reload`.
  - *Deployed:* separate Railway **environments** (`production` + a forked
    `staging`/`dev`), each with its **own** Railway Postgres; production's DB stays
    private (no public TCP proxy).
  - *Supersedes the original "no local DB" decision* — changed deliberately for
    per-environment DB isolation and fast local schema iteration.

## Non-negotiable invariants

These are architectural constraints, not preferences. Violating one is a bug.

1. **Plaid security invariant.** The browser talks to Plaid in exactly one way —
   Plaid Link — and never sees the Plaid secret or any `access_token`, and never
   calls a Plaid data endpoint. All data-endpoint calls (`/transactions/sync`,
   balances, etc.) happen backend-side with the encrypted-at-rest `access_token`.
2. **Sync transactionality.** `/transactions/sync` returns `added` / `modified` /
   **`removed`** — all three must be applied. In one DB transaction: upsert
   added+modified, delete/tombstone removed, then write `transactions_cursor`
   **strictly last**. The failure mode must always be "reprocess," never "skip."
3. **Per-item concurrency.** Wrap `runSync(itemId, products)` in
   `pg_try_advisory_lock(hashtext(item_id))` (non-blocking `try` variant; acquire
   *before* Plaid I/O, open the DB write transaction only at the end, release in
   `finally`). The cron and a webhook can both target the same item in separate
   processes — an in-memory lock is wrong; the lock must live in Postgres.
4. **Account = identity, item = provenance.** An `item` is a transient Plaid login
   session, replaced on revoke/re-link. `accounts` are anchored on Plaid's
   `persistent_account_id` with a `current_item_id` FK; `transactions` key to the
   **account**, never the item. On re-link, re-point accounts — never fracture
   history. A reconciliation function does this matching.
5. **Idempotency.** Every sync routine must be safe to re-run — the nightly cron is
   the durability safety net and re-runs everything. Webhooks are a near-real-time
   optimization on top, never the correctness mechanism (≤24h stale tolerance).
6. **`user_id` on every data table** from the first migration (single-user today),
   referencing a local `users` table — a plain owned column, no `auth.users` FK.
7. **One-vendor boundary.** Railway Postgres is just Postgres — no auto-REST layer,
   no edge functions, no auth product. All Plaid logic *and* all auth stay in the
   FastAPI backend. The DB is not publicly exposed (private network only).
8. **Hand-rolled auth invariants.** Password stored as a bcrypt hash (never
   plaintext); `JWT_SECRET` from a Railway env var, never in git; `jwt.decode`
   always pins `algorithms=["HS256"]` (no `alg`-confusion); login returns an
   identical 401 for unknown-email and wrong-password and runs bcrypt in both
   cases (no timing leak); `require_auth` gates every data route.
