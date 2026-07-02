# Architecture

How the code is organized and how it actually works — a map to read alongside the
source. This is the *"how"*; the other docs are the *"what/why"* and the *"when"*:

- **`personal-finance-rebuild-architecture.md`** — the locked spec (what is built and why).
- **`BUILD-PLAN.md`** — the phased build order (0–9) and its reasoning.
- **`CLAUDE.md`** — current phase status, commands, and first-time production setup.

When this doc and the code disagree, the code wins — update this doc.

---

## What it is

A single-user (built to scale) personal-finance web app. It links bank accounts via
**Plaid**, syncs them into **Postgres**, and serves a **Next.js** dashboard. The
backend is **FastAPI**; everything runs on **Railway**.

## Three ideas that run through everything

1. **The browser never touches Plaid secrets.** It talks to exactly two things: our
   API, and Plaid Link. It never sees the Plaid secret or an `access_token`, and never
   calls a Plaid data endpoint. All data calls happen backend-side with the
   encrypted-at-rest token.
2. **Account = identity, item = provenance.** A Plaid *item* is a disposable bank-login
   session; *accounts* are the permanent thing transactions hang off. On re-link we
   re-point accounts at the new item so history never fractures.
3. **Every data route is gated by one `require_auth` dependency.** The `user_id` from
   the verified session token drives every `WHERE user_id` filter.

The full invariant list (concurrency, sync transactionality, hand-rolled-auth rules,
etc.) is in `CLAUDE.md` → *Non-negotiable invariants*.

---

## Repo layout

```
/backend            FastAPI app + plain-SQL migrations (ships as one Railway service)
  app/              application code (see "Backend" below)
  db/migrations/    ordered .sql files; the migrate runner is their only consumer
  railway.json      backend web service config (RAILPACK, migrate on pre-deploy)
  railway.cron.json sync-cron service config (python -m app.sync)
/frontend           Next.js (App Router, React 19, Tremor UI on Tailwind v4)
  app/lib/          data layer + helpers
  app/components/   Tremor-style UI components
  railway.json      frontend service config (RAILPACK, next start)
/scripts            ops (backups)
docker-compose.yml  local Postgres for dev
```

---

## Backend (`backend/app/`)

### Foundation / plumbing

| File | Job |
|---|---|
| `config.py` | All settings from env (`DATABASE_URL`, `JWT_SECRET`, Plaid keys, `ACCESS_TOKEN_ENC_KEY`, `CORS_ALLOW_ORIGINS`, `APP_USER_EMAIL`). `get_settings()` is `lru_cache`d — read once per process. |
| `db.py` | `connect()` (a connection that commits on clean exit / rolls back on error), `ping()`, and `fetch_all()` (dict rows for the read API). |
| `migrate.py` | Applies `db/migrations/*.sql` in filename order, once each, tracked in `schema_migrations`; per-file transaction; refuses to run if an already-applied file changed (checksum drift). |
| `crypto.py` | Fernet `encrypt_token` / `decrypt_token` for the Plaid `access_token`. The DB only ever holds ciphertext. |
| `plaid_client.py` | Builds the Plaid SDK client from env (client id / secret / environment). |
| `users.py` | `get_or_create_default_user` — bootstraps the single `users` row (idempotent, keyed on `APP_USER_EMAIL`). |
| `main.py` | The FastAPI app: CORS middleware + all routers + `/health` and `/health/db`. |

### Flow 1 — Link a bank (`plaid_routes.py`, `reconcile.py`)

```
Browser                         Backend                         Plaid
  |  POST /link/token/create ----->|  (require_auth)               |
  |                                |----- link_token_create ------>|
  |<-------- link_token -----------|<---------- link_token --------|
  |  [opens Plaid Link, user authenticates at their bank]          |
  |  POST /item/public_token/exchange {public_token} (require_auth)|
  |                                |-- item_public_token_exchange ->|
  |                                |<-------- access_token ---------|
  |                                |  encrypt + store item row      |
  |                                |-- accounts_get --------------->|
  |                                |  reconcile_accounts()          |
  |<---- accounts summary ---------|  (NO access_token in response) |
```

`reconcile_accounts` (`reconcile.py`) is the identity brain: for each incoming account
it matches an existing one by `persistent_account_id` → `plaid_account_id` →
`(mask, type, subtype, name)` **within the same institution**, and re-points it at the
new item — or inserts it if new. This is what keeps history attached across re-links.

### Flow 2 — Sync transactions (`sync.py` — the engine)

```
cron (nightly) or webhook  --->  run_sync(item):
  1. pg_try_advisory_lock(hashtext(plaid_item_id))   # skip if already syncing
  2. drain Plaid /transactions/sync  -> added / modified / removed  (+ next cursor)
  3. ONE transaction:
        upsert added + modified
        tombstone removed  (removed_at)
        write transactions_cursor   <-- STRICTLY LAST
  4. release lock (finally)
```

The ordering is the whole point: the cursor advances only after rows are durably
written, so any failure **re-processes** rather than **skips**. `run_sync` is
idempotent; `sync_all_items` runs it over every live item and is the nightly cron
entrypoint (`python -m app.sync`). A mid-sync `ITEM_LOGIN_REQUIRED` flips
`items.status` and stops without advancing the cursor.

### Flow 3 — Webhooks (`webhooks.py`, `webhook_routes.py`)

`webhooks.py` verifies every incoming Plaid webhook: ES256 with the algorithm pinned
(alg-confusion defense), `kid` → key via `/webhook_verification_key/get` (cached),
`request_body_sha256` matched against the raw body, and `iat` freshness.
`webhook_routes.py` is a deliberately thin handler: **verify → branch → return 200
fast**, with any `run_sync` kicked off in a background task (never inline).
`SYNC_UPDATES_AVAILABLE` → background sync; `ITEM` webhooks → update `items.status`.
Webhooks are a *speed* optimization on top of the cron — never the correctness
mechanism (the cron re-syncs everything nightly regardless).

### Flow 4 — Auth + read API (`auth.py`, `auth_routes.py`, `read_routes.py`)

```
Browser  POST /auth/login {email,password}
   -> verify bcrypt hash (runs in both branches; identical 401 on failure)
   -> mint HS256 JWT { sub: user_id, exp: +12h }
   -> browser stores it (localStorage)

Browser  GET /api/... with  Authorization: Bearer <jwt>
   -> require_auth: jwt.decode(..., algorithms=["HS256"])  # pinned
   -> returns user_id (sub)
   -> route runs  SELECT ... WHERE user_id = <sub>  against a v_* view
```

| File | Job |
|---|---|
| `auth.py` | `hash_password` / `verify_password` (bcrypt), `create_session_token` (HS256), and the `require_auth` dependency that gates every data/write route. |
| `auth_routes.py` | `POST /auth/login` — identical 401 for unknown-email vs wrong-password, bcrypt run in both branches (no enumeration / timing leak). |
| `set_password.py` | One-time CLI (`python -m app.set_password`) that writes a real bcrypt hash onto the existing `users` row in place. There is **no signup endpoint** — this is the credential bootstrap. |
| `read_routes.py` | `GET /api/transactions` (paginated + account/date filters), `/api/summary/monthly`, `/api/summary/category`, `/api/accounts`. All `require_auth`; all filter `WHERE user_id` from the token; all read from `v_*` views, never raw tables. |

### Data model (`db/migrations/`)

- **`0000_baseline.sql`** — empty baseline (proves the migration mechanism).
- **`0001_initial_schema.sql`** — the tables. `users` (bcrypt `password_hash`), `items`
  (provenance: encrypted token, `transactions_cursor`, health `status`), `accounts`
  (identity: anchored on `persistent_account_id`, `current_item_id` FK),
  `transactions` (keyed to the **account**, `removed_at` tombstone),
  `transaction_overrides`, plus the Phase-5 product tables (`recurring_streams`,
  `securities`, `holdings`, `investment_transactions`, `liabilities`). Every data table
  carries `user_id`.
- **`0002_read_views.sql`** — the read contract as SQL views:
  - `v_transactions` — live transactions (`removed_at IS NULL`) joined to account +
    institution, with `transaction_overrides` LEFT JOIN'd so manual edits win.
  - `v_monthly_summary` — income / spending / net per month.
  - `v_category_summary` — spending per category per month.
  - Plaid sign convention: `amount > 0` is money **out** (spending), `< 0` is money
    **in** (income). *Known gap:* the summaries count every outflow as "spending", so
    transfers/loan-payments inflate the category charts — a future view refinement.

### The seam that ties auth to everything

Phase 2 shipped a `current_user_id()` stand-in so data could attach before auth
existed. Phase 7a replaced it with `require_auth` — same shape (a dependency yielding
`user_id`), so route call sites didn't change. That's why auth could be retrofitted
onto the Plaid write endpoints without churn.

---

## Frontend (`frontend/app/`)

### Data layer (`lib/`)

| File | Job |
|---|---|
| `api.ts` | The single channel to the backend. Stores the JWT (localStorage), `apiFetch` attaches `Authorization: Bearer` and throws `UnauthorizedError` on 401 (→ redirect to `/login`), plus typed calls: `login`, `getTransactions`, `getMonthlySummary`, `getCategorySummary`, `getAccounts`, and the Plaid `createLinkToken` / `exchangePublicToken`. `NEXT_PUBLIC_API_URL` is the backend base (baked at **build** time). |
| `format.ts` | Money / date / month formatting; signed-amount + inflow helpers. |
| `utils.ts` | Tremor's `cx` (clsx + tailwind-merge) and focus/error class constants. |
| `chartUtils.ts` | Chart color palette + deterministic category→color assignment. |

### Pages & auth

- **`login/page.tsx`** — hand-rolled sign-in: POST `/auth/login` → store token →
  redirect. One generic error (mirrors the backend's identical 401).
- **`page.tsx`** — the dashboard. Client-rendered (auth is a localStorage JWT, no SSR
  access). On mount: auth-guard, then load transactions + monthly + category + accounts
  in parallel. Renders the KPI row, trend chart, category donut + BarList, and the
  transactions table with the account filter. The filter re-fetches transactions via
  `/api/transactions?account_id=…` (summaries stay all-accounts).

### Components

`ui/Card` + `ui/Button` (primitives), `KpiCard` (income/spending/net tiles),
`charts/TrendArea` + `charts/CategoryDonut` (Recharts — what Tremor's charts wrap),
`BarList` (ranked categories), `TransactionsTable`, `AccountSelect`, and `LinkButton`
(drives the Flow 1 add-a-bank sequence via `react-plaid-link`).

### Styling / stack

Tremor's current **copy-in** model (not the deprecated `@tremor/react` package):
Tailwind CSS v4 + `tailwind-variants`/`clsx`/`tailwind-merge`, `@remixicon/react`
icons, Geist font, Recharts. `lib/utils.ts` and the `globals.css` `@theme` follow
Tremor's official Next.js guide; components are hand-copied into `components/`.

---

## Deployment (Railway)

Four services in one Railway project (`production` env), Sandbox-backed until the
Phase 9 cutover:

- **backend** — FastAPI web service; migrations auto-apply on deploy (`railway.json`
  pre-deploy). Public URL.
- **Postgres** — private (no public TCP); reachable only over the project's private
  network. Prod DB is inspected only from a shell inside a Railway service.
- **sync-cron** — `python -m app.sync` on a schedule (`railway.cron.json`).
- **frontend** — `next start` (`frontend/railway.json`).

Two env vars wire frontend↔backend and must point at each other: `NEXT_PUBLIC_API_URL`
(frontend → backend URL, **build-time**, must include `https://`) and
`CORS_ALLOW_ORIGINS` (backend → frontend origin, exact match, backend restarts to
apply). Full first-time setup (`JWT_SECRET`, `set_password`, the frontend service) is
in `CLAUDE.md` → *First-time production setup*.

---

## Local development

- **DB:** `docker compose up -d` (local Postgres) with `DATABASE_URL` in a git-ignored
  `backend/.env`.
- **Backend:** `uvicorn app.main:app --reload` (from `/backend`, venv active). Migrate
  with `python -m app.migrate`.
- **Frontend:** `npm run dev` (from `/frontend`). Set `JWT_SECRET` in `backend/.env`
  and run `python -m app.set_password` once to enable login locally.
- Don't run `npm run build` while `npm run dev` is live — they share `.next` and the
  build corrupts the dev server's chunks.

---

## Extending it (common changes)

- **Add a Plaid product (Phase 5):** reuse the `sync.py` shape — advisory lock →
  fetch → one transactional upsert — against the existing product tables. No new
  architecture; it's the proven pattern repeated.
- **Add a read endpoint:** add a view in a new migration, then a `require_auth`-gated
  handler in `read_routes.py` that `SELECT`s from it with `WHERE user_id = %s`.
- **Add a dashboard view:** add a typed call in `lib/api.ts`, then a component under
  `components/` composed into `page.tsx`.
