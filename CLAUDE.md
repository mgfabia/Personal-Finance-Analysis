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
`persistent_account_id` → `plaid_account_id` → `(mask,type,subtype,name)`
**scoped to the same `plaid_institution_id`**, re-point `current_item_id`). The
institution scope on the fingerprint fallback is load-bearing: without it,
different banks with lookalike accounts merge (every Plaid Sandbox bank returns
the same canonical account set with null persistent ids) — fixed in `2bd795f`.
The single user is bootstrapped via `app/users.py`'s `get_or_create_default_user`;
the request-time seam is now `require_auth` (Phase 7a). Verified end-to-end
against Plaid Sandbox.

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

Outstanding follow-ups (none block the active phase):
- Nightly backup: code complete (`scripts/backup.sh` + `backup.Dockerfile` +
  `railway.backup.json` — pg_dump → age-encrypt → rclone to Cloudflare R2;
  round-trip verified locally). Pending: the one-time Railway/R2 dashboard
  setup (bucket, token, env vars, cron service) — steps in the *Backups*
  subsection under Commands.
- A true forked `staging` env is deferred until there's real data to protect
  (closer to Phase 9); today prod is Sandbox-backed.
- **Prod setup for 7a/8 (pending):** `JWT_SECRET`, `set_password`, the frontend
  service, and dropping the dead `API_SHARED_SECRET` — see the *First-time
  production setup (Phase 7a/8)* section under Commands for the full steps.

**Build order reprioritized (2026-06-30):** auth and the frontend are pulled ahead
of Phase 5, which moves to last among the feature work. See the *Revision —
build-order reprioritization* section in `BUILD-PLAN.md` for the full rationale and
the revised sequence: **7a → 8 core → 5 → 7b → 6 → 9** (phase *numbers* unchanged as
stable IDs; only the build order changed).

**Phase 7a (Hand-rolled auth + transaction read API) — complete (code; verified
locally).** `app/auth.py`: bcrypt `hash_password`/`verify_password`,
`create_session_token` (HS256, `sub`=user_id, 12h `exp`), and the `require_auth`
dependency (pins `algorithms=["HS256"]`, inv. 8) that **replaced the
`current_user_id` seam**. `POST /auth/login` (`app/auth_routes.py`) returns an
identical 401 for unknown-email and wrong-password and runs bcrypt in both branches
(decoy hash) — no enumeration/timing leak. `python -m app.set_password` writes a real
bcrypt hash onto the existing `APP_USER_EMAIL` row in place (preserves the user_id +
attached data). The two Plaid write endpoints now `Depends(require_auth)`; the
interim `X-API-Key` guard (`app/security.py`) is deleted. Read API
(`app/read_routes.py`, all `require_auth`-gated, `WHERE user_id` from the token):
`GET /api/transactions` (paginated, account/date filters), `/api/summary/monthly`,
`/api/summary/category`, served from views in
`backend/db/migrations/0002_read_views.sql` (`v_transactions` with overrides
LEFT JOIN'd + `removed_at` filtered; monthly/category rollups). Verified end-to-end
against synced Sandbox data: login happy-path, identical-401 failure modes, forged
(wrong-secret) and expired tokens both rejected, write endpoints 401 without a token.
The net-worth view (Phase 7b) stays deferred until Phase 5 lands its inputs.

**Phase 8 (frontend core) — complete (code; verified locally).** Next.js 15.5
(App Router, React 19, TS strict) in `/frontend`, hosted on **Railway** (same
project — decided 2026-06-30; not Vercel, to stay single-vendor for a thin
auth'd SPA that needs no SSR/edge). Built on **Tremor** via its current copy-in
model (NOT the deprecated React-18-pinned `@tremor/react` package): **Tailwind
CSS v4** + `tailwind-variants`/`clsx`/`tailwind-merge`, `@remixicon/react` icons,
Geist font, and **Recharts** for charts — set up per Tremor's official Next.js
guide (`lib/utils.ts` `cx`/focus constants and the `globals.css` `@theme` are
verbatim from it). Tremor-style components are hand-copied into `app/components/`
(no CLI exists): `ui/Card`, `ui/Button`, `KpiCard`, `BarList`, `AccountSelect`,
`charts/CategoryDonut` (donut) + `charts/TrendArea` (area), `TransactionsTable`,
`LinkButton`. Client-rendered (auth is a localStorage JWT, no SSR access).
`app/lib/api.ts` is the single API channel: `login` stores the JWT, `apiFetch`
attaches `Authorization: Bearer` and bounces to `/login` on 401
(`UnauthorizedError`). Pages: `/login` (hand-rolled sign-in, generic error to
match the backend's identical 401) and `/` (dashboard — auth guard; parallel load
of transactions + monthly summary + **category summary** + accounts). Dashboard
shows KPI tiles (income/spending/net), an income-vs-spending area chart, a
spending-by-category donut + top-categories BarList, and the transactions table
with an **account filter** (re-fetches via `/api/transactions?account_id=`).
Added read endpoint `GET /api/accounts` and `getCategorySummary`. `components/
LinkButton` drives the Phase 2 add-a-bank flow via `react-plaid-link` (browser
never sees the secret/access_token, inv. 1). Backend gained `CORSMiddleware`
(`CORS_ALLOW_ORIGINS`, default `localhost:3000`). Verified locally: `npm run
build` clean (types valid), CORS preflight allows the FE origin and rejects
others, and the full cross-origin login → bearer → all four read endpoints
returns real synced Sandbox data (2 banks, 24 accounts, 96 txns).
**Not yet done** (deferred by dependency): the **reconnect banner** (needs Phase 6
re-auth backend) and any balances/investments/net-worth UI (needs Phase 5 / 7b).
Known data-semantics note: `v_*_summary` count every outflow as "spending", so
`TRANSFER_OUT`/`LOAN_PAYMENTS` dominate the category charts — a future view
refinement, not a bug.

**Next: Phase 5** (Remaining products — balances, recurring, investments,
liabilities; the same lock-and-upsert shape under the proven engine).

Build order is defined in `BUILD-PLAN.md` (Phase 0 → throwaway Phase S walking
skeleton → correctness phases 1–9), as amended by the 2026-06-30 reprioritization
revision at the top of that file.

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

**Backups:** nightly `pg_dump` → `age`-encrypt → upload to Cloudflare R2, as a
dedicated Railway cron service built from `scripts/backup.Dockerfile` (config:
`scripts/railway.backup.json`, daily 09:30 UTC — after the nightly sync so the
dump includes it). `scripts/backup.sh` is provider-agnostic: R2 lives entirely
in env vars. Encryption is asymmetric (age): `AGE_RECIPIENT` (public key) in
env can only *encrypt*; the private key lives offline in the password manager —
a leaked bucket/token/env yields ciphertext only. Local run:
`DATABASE_URL=... AGE_RECIPIENT=... UPLOAD_CMD=... ./scripts/backup.sh`.

One-time setup (Railway + Cloudflare dashboards):
1. Generate the age keypair **locally** (`brew install age && age-keygen`):
   private key → password manager (lose it = backups unreadable); public key
   (`age1...`) → the `AGE_RECIPIENT` env var.
2. Cloudflare: create a private R2 bucket (e.g. `pf-backups`); create an R2 API
   token, **Object Read & Write, scoped to that bucket only**; note the
   account-id endpoint. Add a lifecycle rule (e.g. delete after 90 days) for
   bucket-side retention.
3. Railway: new service from this repo, config path
   `scripts/railway.backup.json`, env vars: `DATABASE_URL` =
   `${{Postgres.DATABASE_URL}}`, `AGE_RECIPIENT`, `UPLOAD_CMD` =
   `rclone copy "$1" R2:pf-backups/`, and rclone's R2 connection:
   `RCLONE_CONFIG_R2_TYPE=s3`, `RCLONE_CONFIG_R2_PROVIDER=Cloudflare`,
   `RCLONE_CONFIG_R2_ACCESS_KEY_ID`, `RCLONE_CONFIG_R2_SECRET_ACCESS_KEY`,
   `RCLONE_CONFIG_R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com`
   (the account id appears exactly once; paste the dashboard's S3 endpoint as
   the whole value), and `RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true` — required
   with a bucket-scoped token: rclone otherwise tries an account-level
   bucket-exists/create call the scoped token rightly lacks, and 403s with
   "failed to prepare upload: AccessDenied". Reconfigure the tool; never widen
   the token to Admin to make the error go away.
4. Trigger a manual run; confirm the `.age` object lands in the bucket; then do
   one restore drill (runbook below) so the recovery path is *tested*, not hoped.

There are no test or lint commands yet; add them here when introduced.

**Logging/observability:** both the API and the sync cron emit structured JSON
log lines to stdout via `app/logging_setup.py`; Railway's observability aggregates
and parses them (filter by `item`, `status`, `user_id`, `duration_ms`, …). Env
knobs: `LOG_LEVEL` (default `INFO`), `LOG_FORMAT` (`json` default; set `plain` in
local dev for a readable console). Read-based only — no alerting/dead-man's-switch
yet (deferred; the nightly-cron email digest is planned for Phase 6). The API logs
one access line per request + a global handler line for any unhandled 500; the
cron logs one line per item plus a `sync.complete` summary (ERROR level + non-zero
exit when any item failed).

## First-time production setup (Phase 7a/8)

The code auto-deploys on push and migrations auto-apply, but auth + frontend need
one-time config/data that isn't in git. Do this once on Railway.

**1. Set `JWT_SECRET` (backend service).** The HS256 signing key for session
tokens; `require_auth`/`create_session_token` read it from env and the app *raises*
if it's empty (login would 500). Generate and set — never commit it:
`python -c "import secrets; print(secrets.token_urlsafe(64))"`.

**2. Set the login password with `set_password`.** There is **no signup endpoint**
by design (single-user; the spec excludes it) — `set_password` *is* the credential
bootstrap. Phase 2 created the one `users` row with a deliberately unusable
placeholder hash (fail-closed until a password is set); `set_password` overwrites it
**in place** (keyed on `APP_USER_EMAIL`), preserving the row's `id` so all attached
data stays attached. Must run **inside Railway** (the prod DB is private, inv. 7 —
unreachable from a laptop; and `getpass` needs a TTY):
```
railway ssh        # or the backend service's Shell in the dashboard
python -m app.set_password        # prompts, no echo; do NOT use --password (logs plaintext)
psql "$DATABASE_URL" -c "SELECT email, left(password_hash,7) FROM users;"  # verify: $2b$12$, not !placeh
```
`APP_USER_EMAIL` is **not** set in prod, so it defaults to `owner@localhost`
(`config.py`) — which is what prod bootstrapped with, so `set_password` targets that
same row and you log in as `owner@localhost`. **To use a real email, RENAME the
existing row — never create a second one** (a new row = data stranded under the old
`id`, the "two-users trap"): `UPDATE users SET email='you@example.com';` then set
`APP_USER_EMAIL` to match and run `set_password`.

**3. Deploy the frontend as a new Railway service** (same project; decided
2026-06-30, not Vercel). Root `/frontend`, build `npm run build`, start `npm run
start`. Set two vars that point at each other: `NEXT_PUBLIC_API_URL` (frontend) = the
backend's public URL; `CORS_ALLOW_ORIGINS` (backend) = the frontend's public URL
(else the browser blocks cross-origin API calls; both default to localhost).

**4. Drop `API_SHARED_SECRET` (backend).** Dead since the interim `X-API-Key` guard
was deleted (real auth replaced it). Cleanup only — harmless if left.

Order: 1→2 makes prod auth work; 3 is independent; 4 anytime.

## Security runbooks

Incident procedures — written down *before* they're needed. All secrets rotate via
Railway env vars; none require code changes.

- **Session token leaked / suspected** (JWT copied from localStorage, device
  stolen): rotate `JWT_SECRET` on the backend service and redeploy. Sessions are
  stateless HS256, so rotating the secret instantly invalidates **every** token —
  there is no per-token revocation, and that's fine for one user (you just log in
  again). Also change the password (`set_password`) if the device could have
  captured it.
- **`ACCESS_TOKEN_ENC_KEY` leaked / scheduled rotation**: three-step MultiFernet
  rotation — prepend the new key (comma-separated, newest first), deploy, run
  `python -m app.rotate_enc_key` inside Railway, then drop the old key. Full
  runbook in `app/crypto.py`'s docstring. Never *replace* the key in one step —
  stored tokens would be orphaned and every bank would need a manual re-link.
- **Plaid credentials leaked** (`PLAID_SECRET`): rotate in the Plaid dashboard
  (it supports two live secrets for exactly this), update the Railway env var.
  Existing access_tokens keep working — they're bound to the client_id, not the
  secret.
- **Locked out by the login throttle** (3 failures / 30 min, global): wait out
  the window, or restart the backend service (the budget is in-memory). Check
  `logger = "app.auth"` in Railway logs first — if the failures weren't yours,
  that's an active attack, not a typo.
- **Database compromise suspected**: access_tokens in `items` are ciphertext
  (useless without `ACCESS_TOKEN_ENC_KEY` — separate system), but rotate both
  that key and `JWT_SECRET` anyway, and audit Plaid dashboard logs for
  unexpected API calls.
- **Restore from backup** (data loss / bad migration / disaster): fetch the
  newest dump from R2 (`rclone copy r2:pf-backups/pf_<TS>.dump.age .` or the
  Cloudflare dashboard); decrypt with the private key from the password
  manager: `age --decrypt -i key.txt -o pf.dump pf_<TS>.dump.age`; restore:
  `pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" pf.dump`.
  Restores everything including `transaction_overrides` (the un-refetchable
  user edits). Worst case is losing only the deltas since the last nightly run,
  and post-restore syncs re-pull those from Plaid (cursors are in the dump; §2
  reprocess-never-skip applies). Known residual risk (accepted 2026-07-06): the
  R2 token in Railway env can read+delete bucket objects (R2 has no write-only
  tokens or versioning), so a full Railway env compromise could destroy backups
  too; encryption still keeps them unreadable.

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

For *how the code is organized and works* (the map — layers, the four flows, data
model, deployment), see **`ARCHITECTURE.md`**. It tracks the code, not the spec: when
it and the code disagree, the code wins and the doc gets updated.

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
