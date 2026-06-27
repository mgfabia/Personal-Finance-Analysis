# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This is a **pre-implementation** repository. There is no application code yet — only
the architecture spec and a build roadmap. The first code to be written is Phase 0
(monorepo skeleton + migration tooling), followed by the deliberately throwaway
**Phase S "walking skeleton"** (a learning-first end-to-end slice) before the
correctness phases — all defined in `BUILD-PLAN.md`.

There are therefore **no build, lint, test, or run commands yet**. When you add the
first toolchain (FastAPI backend, Next.js frontend, SQL migration runner), update
this file with the real commands.

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
- **Repo layout:** monorepo — `/backend` (FastAPI), `/frontend` (Next.js),
  `/db` (plain SQL migrations).
- **Dev environment:** hosted Plaid **Sandbox** + a hosted Railway Postgres (no
  local DB). Build everything in Sandbox; Production cutover is the last phase.

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
