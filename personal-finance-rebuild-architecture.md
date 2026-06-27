# Personal Finance App — Rebuild Architecture

Target architecture for the rebuilt personal finance app, moving off the
Raspberry Pi onto hosted infrastructure. This revision locks the service
choices that the original doc deferred, and closes the Plaid item re-auth gap.

**Stack revision (Railway-only):** Supabase is dropped. Postgres is now
self-hosted on Railway (one vendor, one private network, one bill, and the
operational learning of running the database directly). Dropping Supabase also
drops Supabase Auth, so auth is now **hand-rolled** (single-user: bcrypt +
self-signed session JWT). See the hand-rolled auth section at the end — it is
the one component this change makes load-bearing, so it is specified in full.

## Goals

- Move off the Raspberry Pi onto hosted infrastructure.
- A web app where I sign in and see my transactions, balances, recurring bills,
  investments, and liabilities.
- Hands-on experience with the Plaid API across multiple products and webhooks.
- Simpler data layer — **drop dbt**, express transformations as plain SQL views.

## Locked service choices

Service selection was deferred in the original doc. It is now decided. The
priorities that drove these choices: **maximize Plaid + full-stack learning
first, keep monthly cost modest (~$10–12/mo is accepted — two always-on Railway
services plus the frontend), keep ops mostly managed.**

| Concern | Choice | Why |
|---|---|---|
| **Backend + worker host** | **Railway** | One always-on FastAPI service + native cron. Lowest-friction managed PaaS; handles OS/TLS/deploys. Fits the narrow job (public API + cron); the self-hosted Postgres sits beside it in the same project. |
| **Backend language** | **Python / FastAPI** | Async fits the webhook "200-fast" pattern; it's the daily-driver language; Plaid SDK + verification are clean in it. |
| **Database** | **Railway Postgres** (self-hosted container) | Plain managed-by-me Postgres on the same Railway private network as the backend — "raw tables + SQL views, no dbt" drops in untouched. SQL migrations version the `CREATE VIEW`s. *Unmanaged* (I own backups/config), which is the point: operational learning. |
| **Auth** | **Hand-rolled** (bcrypt + signed JWT, single-user) | No Supabase Auth without Supabase. Single-user app → small surface: one bcrypt'd password, a self-signed session JWT, a `require_auth` dependency on every route. `user_id` becomes a plain owned column (no `auth.users` FK). |
| **Worker topology** | **Internal function** of the backend (`runSync(itemId, products)`), not a separate service | Acceptable because the nightly cron is the durability safety net (see below). |

> **Why not Fly.io / AWS:** Fly's edge was "most real infra to learn" — but
> with Postgres now self-hosted on Railway, the DB/ops learning is back in scope
> without taking on Docker rope or a second vendor. AWS (ECS/Fargate + RDS +
> EventBridge) would teach the most but overshoots the ~$10–12/mo budget (RDS
> alone) and is the opposite of "keep it managed." Right tools if cost weren't a
> constraint; it is. (A serverless AWS variant — Lambda + SQS-FIFO-per-item + EventBridge +
> Aurora/DynamoDB — is the documented "if it goes public" target; see the
> scaling path. It is deliberately not the v1 build.)

> **One-vendor boundary:** backend and Postgres are two services in one Railway
> project, talking over the private network via `DATABASE_URL`. Keep all Plaid
> logic and all auth in the FastAPI backend. The database is just Postgres — no
> auto-REST layer, no edge functions, no auth product to lean on. This is more
> surface I own (auth, backups) and is the intended tradeoff.

## What's changing from the current system

| Today (Pi) | Rebuild |
|---|---|
| Local PostgreSQL | **Railway Postgres** (self-hosted, same project) |
| dbt medallion (bronze/silver/gold) | Raw tables + plain SQL views |
| Grafana dashboards | Custom web app (hand-rolled sign-in) |
| `crontab` on the Pi | **Railway cron** + Plaid webhooks |
| Transactions only (sync) | Transactions, Balances, Recurring, Investments, Liabilities |
| Secrets in local files (Fernet) | **Railway secret env vars** (server-side) |
| (none — local only) | **Nightly `pg_dump` to off-Railway storage** (I own backups now) |

## The Plaid interaction model (the core concept)

The frontend talks to Plaid in **exactly one way** — Plaid Link — and never
touches data endpoints or secrets.

**Frontend ↔ Plaid = Plaid Link only:**

1. Frontend asks *our* backend for a `link_token` → backend calls
   `/link/token/create` (requires the Plaid secret).
2. Frontend opens Plaid Link (`react-plaid-link`) with that token; the user
   authenticates with their bank **inside Plaid's UI**.
3. Plaid returns a short-lived `public_token` to the frontend.
4. Frontend POSTs the `public_token` to *our* backend → backend calls
   `/item/public_token/exchange` → receives the long-lived `access_token`,
   stores it encrypted **server-side**.

**Everything else = backend ↔ Plaid.** All data endpoints
(`/transactions/sync`, balances, investments, etc.) are called from the backend
using the `access_token` + secret.

> **Security invariant:** the browser never sees the `access_token` or the Plaid
> secret, and never calls a Plaid data endpoint. This is non-negotiable.

## Components

Four logical components. The webhook handler and the scheduled worker share
one backend codebase/deploy on Railway — they are not separate services.

```
Browser ──Login (hand-rolled auth)──▶ Backend.auth
   │
   ├─Link flow──▶ Backend: /link/token/create, /item/public_token/exchange
   │                           │ store access_token (encrypted, server-side)
   ├─reads──────▶ Backend: /api/transactions, /balances, /holdings, /recurring …
   │                           │ (SQL views over raw tables)
   └─reconnect──▶ Backend: /link/token/create WITH access_token (update mode)
                              │ repairs broken item in place
Plaid ──data webhook POST──▶ Backend.webhook  (verify → enqueue sync → 200)
Plaid ──ITEM webhook POST──▶ Backend.webhook  (verify → set item status → 200)
                              │
                ┌─────────────┴──────────────┐
                ▼                             ▼
        Sync worker (on webhook)      Sync worker (nightly Railway cron)
                └──────────┬──────────────────┘
                           ▼
              for each item: run the 5 sync routines → upsert → Postgres
                           │
                           └─ cron tail: email digest if any item unhealthy
```

1. **Frontend (web app)** — hand-rolled sign-in (password → session JWT); views
   data from our DB via our API; runs Plaid Link to add/relink banks. No Plaid
   secrets.
2. **Backend API (Railway)** — auth-gated read endpoints (served from SQL
   views), Plaid Link endpoints (token create + exchange, plus update-mode token
   create), the webhook receiver, and the login endpoint that issues JWTs.
3. **Sync worker** — idempotent per-product sync routines as an internal backend
   function (`runSync(itemId, products)`). Invoked two ways: on a verified
   webhook, and on the nightly Railway cron.
4. **PostgreSQL (Railway)** — raw tables, derived SQL views, and app tables.
   Self-hosted container on the project's private network; I own backups
   (nightly `pg_dump`) and config.

## Plaid product scope

All five products below are in scope. Each becomes an idempotent sync routine
(call endpoint → upsert raw rows). Same pattern repeated — good for learning.

| Product | Endpoint(s) | Webhook | Feeds |
|---|---|---|---|
| **Transactions** | `/transactions/sync` (cursor per item) | `SYNC_UPDATES_AVAILABLE` | core txn history, classification views |
| **Balances** | `/accounts/balance/get` (forces fresh) / `/accounts/get` (cached) | — (cron / on-demand) | current account balances |
| **Recurring** | `/transactions/recurring/get` | `RECURRING_TRANSACTIONS_UPDATE` | subscriptions / bills |
| **Investments** | `/investments/holdings/get`, `/investments/transactions/get` | `HOLDINGS`, `INVESTMENTS_TRANSACTIONS` | holdings, net worth |
| **Liabilities** | `/liabilities/get` | `DEFAULT_UPDATE` (liabilities) | APRs, balances, due dates |

> **Balances freshness (decide explicitly):** Balances is the one product with no
> webhook. For a personal net-worth view, the **nightly cron driving cached
> `/accounts/get`** is enough. Reserve `/accounts/balance/get` (forces a fresh,
> slower, costlier pull) for on-demand "refresh now" only.

> **Cost note (ops, not architecture):** in **Production**, Plaid bills per
> product per Item. Build all five in **Sandbox** (free); in Production, enable
> only the products you actually look at. Confirm current pricing/free allotment
> on Plaid's pricing page before going live.

## Sync strategy — webhook-primary, nightly cron as safety net

Use **both**, with distinct roles:

- **Webhooks (primary):** Plaid POSTs the backend when data is ready; the worker
  syncs on demand. Near-real-time, and the right way to learn Plaid. But a
  webhook can be missed (backend down, dropped delivery, deploy mid-task).
- **Nightly cron (reconciler):** calls every Item's sync routines regardless, so
  a lost webhook means at most one day of lag. Also the trigger for Balances
  (no webhook), a guaranteed daily refresh for Investments/Liabilities, and the
  place the unhealthy-item email digest is sent from.

`/transactions/sync` is cursor-based and idempotent, so re-running it is always
safe — the cron can never double-count.

> **Durability note (the worker-as-internal-function tradeoff):** because the
> worker is a background task inside the single always-on Railway service, a
> deploy or crash mid-sync drops that in-flight task. This is acceptable
> **only because** the nightly cron re-runs everything idempotently — at most a
> few hours' lag. The cron is therefore not optional polish; it is what makes the
> fire-and-forget webhook handler safe. If this ever goes "public-ish," that's
> when a real queue goes between handler and worker — not before.

### Webhook requirements (now satisfied by Railway)

1. **Public HTTPS endpoint.** Railway gives the backend a public HTTPS URL, so
   Plaid can POST it. (This is the real reason the backend can't stay on the Pi
   LAN.)
2. **Verify every webhook.** Plaid signs webhooks (JWT in the
   `Plaid-Verification` header, validated against
   `/webhook_verification_key/get`). Reject anything that fails verification.
3. **Thin handler.** Receive → record "sync needed for item X" (or "status
   change for item X") → return `200` immediately → run the actual work
   asynchronously. Plaid retries on timeout, so never run a full sync inline.

## Item health & re-auth (the closed gap)

Plaid Items break for ordinary reasons — the user changes their bank password,
the bank changes MFA, the login expires, or access is revoked. When this
happens the `access_token` stays valid as an identifier, but data calls return
`ITEM_LOGIN_REQUIRED`. The item must be repaired via **Plaid Link in update
mode**. This is built in v1 (lazily — it reuses the existing Link integration).

### Item-health state (added to `items`)

- `status` — `healthy` / `login_required` / `pending_expiration` / `revoked`
- `last_synced_at` — when any sync last succeeded for this item
- `last_error` — Plaid error code/message from the last failure (debugging)

### How status gets set (two independent signals)

- **`ITEM` webhooks.** Plaid sends item-level webhooks — `ITEM_LOGIN_REQUIRED`,
  `PENDING_EXPIRATION` (a heads-up *before* a login expires — the chance to
  prompt re-auth pre-emptively), and `ERROR`. The existing webhook handler gets
  one branch: for `ITEM`-type webhooks, update `items.status` instead of
  enqueuing a sync.
- **Sync failures.** When a sync routine gets `ITEM_LOGIN_REQUIRED`, it sets
  `status = login_required` and stops. This is the safety net for a missed
  `ITEM` webhook — same philosophy as the rest of the design.

### Update mode (how a broken item is repaired)

1. Backend calls `/link/token/create` **with the existing item's `access_token`**
   included — passing the access_token is the *entire* difference that puts Link
   into update mode for that item.
2. Frontend opens Plaid Link with that token; the user re-authenticates with
   their bank (credentials / MFA).
3. On success, Link's `onSuccess` fires. In update mode there is **no new
   `public_token` to exchange** — the same item is repaired in place, the
   access_token keeps working, and the next sync succeeds.

No new item row, no token exchange, no separate UI screen — one added parameter
and one branch on the existing Link flow.

### Notification (both channels)

- **In-app banner:** any item not `healthy` renders a "Reconnect [Bank]" banner
  that launches update-mode Link. This banner *is* the re-auth UI.
- **Email digest:** at the **end of the nightly cron**, if any item is
  non-healthy, send one summary email. Not from the webhook handler (keep it
  thin), not per-failure (avoids self-spam) — one digest, from the cron.

## Data model

Keep raw tables dumb (what Plaid returns, lightly typed). Put all business logic
in views. **Every data table carries `user_id` from day one** — now a plain
owned column (single-user today, defaulted to the one user; no `auth.users` FK
since there is no Supabase). It still keeps "public-ish someday" cheap.

**Raw (upsert on sync):**

- `items` — one per linked bank; `access_token` (encrypted), `transactions_cursor`,
  institution, products enabled, **`status` / `last_synced_at` / `last_error`**.
- `accounts` — account metadata + latest balances.
- `transactions` — transaction history.
- `recurring_streams` — recurring inflow/outflow streams.
- `holdings`, `securities`, `investment_transactions` — investments.
- `liabilities` — credit/loan details.

**Derived (plain SQL views, versioned as plain `.sql` migration files):**

- Account-based transaction classification (carry over the existing logic).
- Monthly / weekly summaries, category rollups, recurring monthly-equivalent.
- Net worth = balances + holdings − liabilities.
- Computed on read. Promote any single view to a **materialized view**
  (refreshed at the end of the sync job) only if it ever becomes slow — unlikely
  at this data size.

**App tables:**

- `users` — hand-rolled. One row today: `id` (uuid), `email`, `password_hash`
  (bcrypt), `created_at`. The login endpoint checks the password against this;
  every data table's `user_id` references `users.id`.
- `transaction_overrides` — manual edits, LEFT JOIN'd into the views so they
  survive re-syncs (carried over from the current system).

### Why no dbt

dbt's value (incremental builds, testing, lineage, docs across many models) is
overkill for a personal dataset of this size. Plain Postgres views give the same
transformation logic with no build step, no scheduler, and no extra dependency.
The classification logic moves from dbt models into `CREATE VIEW` statements
kept as plain `.sql` migration files, applied in order at deploy.

## Security model

- **Plaid secret & access tokens:** server-side only. `access_token`s encrypted
  at rest. Never sent to the browser.
- **App auth:** hand-rolled (bcrypt password → self-signed session JWT); all
  read/write API routes require a valid JWT via a `require_auth` dependency. The
  app is internet-facing, so HTTPS (Railway-provided) + a real password are
  mandatory. Full spec in the hand-rolled auth section below.
- **DB access:** backend ↔ Postgres over the Railway private network
  (`DATABASE_URL`); the database is not exposed publicly (no TCP proxy enabled
  unless I explicitly need external access).
- **Backups:** nightly `pg_dump` pushed off-Railway (I own this now — it is not
  optional for a finance app).
- **Webhook auth:** verify Plaid's signature on every webhook (see above).
- **Secret storage:** Railway secret env vars (replaces the Fernet-on-disk
  approach).

## Remaining open decisions

Everything the original doc deferred is now decided **except**:

1. **Plaid environment cutover** — build in Sandbox (free), then move to
   Production; confirm per-product-per-Item cost before enabling Production
   products.
2. **Frontend hosting target** — **Vercel** (free tier, first-class Next.js DX,
   but a second vendor — breaks the one-project/one-private-network story and
   means the browser talks to a different origin than the API) vs. **Railway**
   (a third service in the same project, ~one-vendor and same-origin-friendly,
   but more cost and you run the Next.js server yourself). Both are viable at the
   ~$10–12/mo budget; decide before Phase 8. Does not affect any earlier phase.

## Build order (suggested)

1. Stand up Railway Postgres + raw schema (with `user_id` and item-health
   columns from the start) **+ the `users` app table**, so the `user_id` →
   `users.id` reference resolves from the first migration. Wire nightly `pg_dump`
   to off-Railway storage now, not later — it is a finance app.
2. Backend on Railway: Plaid Link endpoints → link a Sandbox item → store
   access_token.
3. Sync worker: `/transactions/sync` routine → Railway cron trigger.
4. Webhook receiver + verification → wire `SYNC_UPDATES_AVAILABLE` to the worker,
   and `ITEM` webhooks to the status updater.
5. Add remaining product sync routines (balances [cron-driven, cached],
   recurring, investments, liabilities).
6. Item re-auth: update-mode link_token endpoint + reconnect banner + nightly
   unhealthy-item email digest.
7. SQL views (classification, summaries, net worth) as plain `.sql` migrations.
8. Hand-rolled auth: login endpoint (issues JWT) + `require_auth` dependency on
   every route (the `users` table already exists from step 1); then the frontend
   (sign-in + read views).
9. Cut over from Sandbox to Production (confirm Plaid cost first).

---

# Revision — review fixes (concurrency, sync correctness, item identity, reconnect)

This section closes four holes found in review. They are the v1 must-fix set;
everything else (deeper encryption, webhook-URL durability, a real queue) is
correctly deferred under the constraints (private app, ≤24h stale-data
tolerance, build-with-scalability-in-mind).

## Constraints that drive these decisions

- **Not going public**, but built with scalability in mind.
- **Stale data must not exceed 24h** → the nightly cron is a sufficient
  correctness safety net, so webhook reliability does not need over-engineering.
  Webhooks stay primary for the learning value, not for correctness.
- **Cron runs as a separate scheduled Railway invocation** (distinct
  start command), not in-process → at sync time there are two distinct
  processes (web service handling a webhook, and the cron container) that can
  both call `runSync` for the same item. An in-memory lock is therefore
  impossible, and would also break the moment a second web replica runs. The
  lock must live in Postgres.

## 1. Per-item sync lock — Postgres advisory lock

Wrap `runSync(itemId, products)` in a **Postgres advisory lock keyed on
item_id**, not `SELECT ... FOR UPDATE`. Reason: `runSync` does slow network I/O
(looping `/transactions/sync` until `has_more` is false). A row lock held in an
open DB transaction across multiple Plaid HTTP round-trips would pin a
connection and row for seconds. Advisory locks are decoupled from transaction
lifetime — acquire before Plaid I/O (no DB transaction open during it), then
open a short write transaction only at the end.

Use the non-blocking `try` variant so the cron skips an item already being
synced by a webhook rather than queuing behind it (the item still gets synced;
it just isn't double-run).

    locked = pg_try_advisory_lock(hashtext(item_id))
    if not locked:
        return                       # another process owns this item; skip
    try:
        # loop Plaid /transactions/sync, accumulate added / modified / removed
        with db.transaction():       # short, opened only now
            upsert(added + modified)
            delete(removed)
            write(new_cursor)        # strictly after row writes, same txn
    finally:
        pg_advisory_unlock(hashtext(item_id))

- `hashtext` returns a 32-bit int → negligible collision risk at personal
  scale. If bulletproofing later, switch to the two-arg
  `pg_advisory_lock(int4, int4)` form with a namespace key.
- This advisory lock is the seam where a real queue slots in later if this ever
  goes public-ish — it makes the worker-split a drop-in, not a redesign.

## 2. Transactionally-correct sync loop

`/transactions/sync` returns three sets: `added`, `modified`, **and
`removed`**. The original "upsert raw rows" framing silently dropped `removed`,
which accumulates ghost transactions. Fix:

- Loop `/transactions/sync` until `has_more` is false, accumulating all three
  sets.
- In a **single DB transaction**: upsert `added` + `modified`, delete (or
  tombstone) `removed`, then write the new `transactions_cursor`.
- The cursor moves **only after** the rows it represents are durably written,
  in the same transaction. Never write the cursor first — a crash between cursor
  write and row write would skip data permanently. Re-running is always safe
  (idempotent), so the failure mode must always be "reprocess," never "skip."

The other four products (balances, recurring, investments, liabilities) have no
cursor and no removed-set; they follow the same lock-and-upsert shape but
simpler.

## 3. Data model — item is provenance, not identity

The original model keyed transactions to `item_id`. But an **item is one Plaid
login session to a bank**; when it is revoked and re-linked, it is the *same
real-world bank and accounts* — only Plaid's session wrapper changed. Keying
transaction identity to `item_id` fractures history on every revoke/re-link
(which happens for ordinary reasons, e.g. a bank-password change) and puts a gap
in the net-worth chart.

Anchor on **stable account identity** instead, using Plaid's
`persistent_account_id` (survives re-linking):

- `items` — the Plaid login session. **Transient**; replaced on revoke/re-link.
- `accounts` — anchored on `persistent_account_id`, with a `current_item_id`
  FK pointing at whichever item currently owns the login.
- `transactions` — keyed to the **account**, not the item.

On revoke + re-link, re-point the affected `accounts.current_item_id` to the new
item; history stays attached to the account and never moves, so net worth stays
continuous. The dead item row is soft-deleted / retired.

The only added v1 work: an account-reconciliation function that, on re-link,
matches the new item's accounts to existing rows by `persistent_account_id` and
re-points them, rather than inserting fresh account rows. This is also the most
scalable choice — it's how multi-item-per-institution and account changes get
modeled later anyway.

## 4. Reconnect banner — two branches

The in-app reconnect banner needs to branch on item status, because update mode
does **not** repair every broken state:

- `login_required` / `pending_expiration` → **update mode** (pass the existing
  `access_token` into `/link/token/create`; repair the item in place; no new
  token exchange).
- `revoked` → **fresh Link** (a genuinely new item), followed by the
  account-reconciliation step in §3 to re-point existing accounts onto the new
  item.

Without the `revoked` branch, a revoked item shows a banner that update mode can
never clear.

### One addition to update-mode `onSuccess`

In update mode there is no `public_token` to exchange, but the frontend must
still POST the backend a "item X repaired" signal so the backend flips
`status` back to `healthy` and triggers a sync. Otherwise the banner persists
until the next nightly cron.

## v1 must-fix checklist

1. `pg_try_advisory_lock(hashtext(item_id))` around `runSync`; acquire before
   Plaid I/O, open the DB write transaction only at the end, release in
   `finally`.
2. Sync loop handles `added` / `modified` / `removed`; cursor written in the
   same final transaction, strictly after row writes.
3. `transactions` key to `account`; `accounts` anchor on
   `persistent_account_id`; `items` carry `current_item_id` (item = provenance).
4. Reconnect banner branches: update mode vs. fresh Link; update-mode
   `onSuccess` pings the backend to flip status to `healthy`.

---

# Hand-rolled auth (replaces Supabase Auth)

This is the one component the Railway-only decision makes load-bearing, and the
one I have not built before. So this section is written to be built from
directly, with the *why* at each step — auth failure modes are subtle, and
copying code without understanding the reasoning is exactly how insecure auth
ships.

The job is small because the app is single-user and private. We are not building
signup flows, password reset, email verification, OAuth, or multi-tenant
isolation. We are building: **prove you know one password, get a token, present
that token on every request.** That is it. Resisting scope creep here is a
feature.

## The mental model (three moving parts)

1. **Password verification** — at login, check the submitted password against a
   stored *hash* (never a stored password). Bcrypt.
2. **Token issuance** — on success, mint a signed JWT that says "this is user X,
   valid until time T." The signature is what makes it unforgeable.
3. **Token verification** — on every protected request, validate the JWT's
   signature and expiry before doing anything. A FastAPI dependency
   (`require_auth`) does this once and every route reuses it.

The JWT is the whole trick: the server doesn't store sessions. It signs a token
with a secret only it knows; when the token comes back, the server re-checks the
signature. If it validates, the token is authentic and unmodified — no database
lookup needed to trust it. That is why this is "stateless" auth.

## Part 1 — storing the password (bcrypt, once)

**Never store the password. Store a bcrypt hash of it.** Bcrypt is a *slow*,
*salted* hash designed for passwords specifically:

- **Salted:** bcrypt generates a random salt per hash and folds it in, so two
  identical passwords produce different hashes. This defeats precomputed
  ("rainbow table") attacks. The salt is stored inside the hash string itself —
  you don't manage it separately.
- **Slow (work factor):** bcrypt is deliberately expensive to compute (a "cost"
  parameter, ~12 is standard). A fast hash like SHA-256 lets an attacker try
  billions of guesses/second against a stolen hash; bcrypt at cost 12 caps that
  at a few hundred/second. Slowness is the security property — do not "optimize"
  it away.

You hash your password **once**, by hand, and insert the row. There is no signup
endpoint to write.

```python
# one-time setup script — run locally, never commit the output to git
import bcrypt
pw = b"your-actual-strong-password"
hashed = bcrypt.hashpw(pw, bcrypt.gensalt(rounds=12))
print(hashed.decode())   # paste into the users table insert
```

```sql
-- the users table (run as a migration)
CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text UNIQUE NOT NULL,
    password_hash text NOT NULL,            -- bcrypt string, includes the salt
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- one row, you:
INSERT INTO users (email, password_hash)
VALUES ('you@example.com', '$2b$12$....the-hash-you-printed....');
```

## Part 2 — the JWT secret (the thing that must not leak)

The JWT is signed with a symmetric secret (HS256). Whoever has this secret can
forge a token for any user. Therefore:

- Generate it with real entropy: `python -c "import secrets; print(secrets.token_urlsafe(64))"`.
- Store it as a **Railway secret env var** (`JWT_SECRET`), never in code, never
  in git. Same handling as the Plaid secret.
- If it ever leaks, rotating it instantly invalidates every issued token (they
  all fail signature verification) — which is the correct panic button.

## Part 3 — the login endpoint (issues the token)

The only unauthenticated write endpoint in the app. Verify the password, mint a
JWT, return it.

```python
import bcrypt, jwt, datetime as dt   # pip install pyjwt bcrypt
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALG = "HS256"
TOKEN_TTL = dt.timedelta(hours=12)        # short-ish; you re-login, no big deal

class LoginBody(BaseModel):
    email: str
    password: str

@router.post("/auth/login")
def login(body: LoginBody):
    row = db.fetchone(
        "SELECT id, password_hash FROM users WHERE email = %s", (body.email,)
    )
    # constant-time-ish: still run bcrypt even if user is missing, to avoid
    # leaking "this email exists" via response timing. Use a dummy hash.
    stored = row["password_hash"] if row else DUMMY_BCRYPT_HASH
    ok = bcrypt.checkpw(body.password.encode(), stored.encode())
    if not row or not ok:
        raise HTTPException(401, "invalid credentials")   # never say WHICH was wrong

    now = dt.datetime.now(dt.timezone.utc)
    token = jwt.encode(
        {
            "sub": str(row["id"]),         # the user_id every data row references
            "iat": now,
            "exp": now + TOKEN_TTL,        # PyJWT enforces this on decode
        },
        JWT_SECRET, algorithm=JWT_ALG,
    )
    return {"access_token": token, "token_type": "bearer"}
```

Two non-obvious things, both deliberate:

- **The error is identical** whether the email is unknown or the password is
  wrong. Telling an attacker "that email isn't registered" leaks which accounts
  exist. One-user app, low stakes — but it's the correct habit and costs nothing.
- **Run bcrypt even when the user doesn't exist** (against a throwaway hash).
  Otherwise the endpoint returns instantly for unknown emails and slowly for
  known ones, and that timing difference leaks the same information. This is a
  *timing side channel* — the classic subtle auth bug.

## Part 4 — verifying the token on every request (the dependency)

This is where the payoff lands: one function, declared as a dependency, gates
every protected route. FastAPI runs it before the route body; if it raises, the
route never executes.

```python
from fastapi import Depends, HTTPException, Header

def require_auth(authorization: str = Header(None)) -> str:
    """Returns the user_id (sub) if the bearer token is valid, else 401."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    token = authorization.split(" ", 1)[1]
    try:
        payload = jwt.decode(
            token, JWT_SECRET,
            algorithms=[JWT_ALG],          # pin the algorithm — see note below
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "invalid token")
    return payload["sub"]                   # the user_id
```

Use it on every data route:

```python
@router.get("/api/transactions")
def list_transactions(user_id: str = Depends(require_auth)):
    return db.fetchall(
        "SELECT * FROM v_transactions WHERE user_id = %s", (user_id,)
    )
```

The `user_id` flows straight from the verified token into the `WHERE user_id`
clause. Single-user today, but this is exactly the line that makes the app
multi-user-safe for free later: a user can only ever read rows tagged with the
`sub` in their own token.

### The one mistake that breaks JWT auth: the algorithm-confusion attack

Always pass `algorithms=["HS256"]` to `jwt.decode` — a fixed allow-list. The
historic JWT vulnerability is the `"alg": "none"` / algorithm-substitution
attack: a library that trusts the token's *own header* to pick the algorithm can
be tricked into accepting an unsigned token, or into verifying an asymmetric
token with the public key as if it were the HMAC secret. Pinning the algorithm
server-side (never trusting the token's header field) closes this. PyJWT
requires the `algorithms=` list, which is why this code is safe — do not remove
it.

## Part 5 — the frontend side (where the token lives)

The frontend POSTs `/auth/login`, gets the token back, and attaches it as
`Authorization: Bearer <token>` on every API call.

Where to store it in the browser is the one real frontend security decision:

- **In-memory (a JS variable / React state):** safest against theft, but the
  user is logged out on every refresh. Annoying for a daily-use app.
- **`localStorage`:** survives refresh, simple — but readable by any JS that runs
  on your page, so it's vulnerable to XSS token theft. Acceptable *only* because
  this is a private single-user app with no third-party scripts; the XSS attack
  surface is basically you attacking yourself.
- **`httpOnly` cookie (the "proper" answer):** the browser stores it, JS cannot
  read it (immune to XSS theft), and it's sent automatically — but then you have
  to think about CSRF, which the bearer-header approach avoids entirely.

For v1 of a private app, `localStorage` + bearer header is the pragmatic choice
and is fine. If this ever goes "public-ish," switch to `httpOnly` cookies and
add CSRF protection — note that in the migration plan, not now.

## What we are deliberately NOT building (scope discipline)

Each of these is real auth work that a single-user private app does not need.
Listing them so the absence is a decision, not an oversight:

- **Signup / registration** — there is one user, inserted by hand.
- **Password reset / email flows** — if you forget it, re-run the bcrypt script
  and update the row.
- **Refresh tokens / session revocation** — a 12h access token that you re-login
  for is enough. (Refresh tokens exist to keep short access tokens convenient at
  scale; not worth the complexity here.)
- **Rate limiting on login** — worth adding if public; for a private app behind a
  URL only you know, deferred. Reconsider before any public exposure.
- **MFA** — out of scope for v1.

## Auth checklist (the parts that must be correct)

1. Password stored as a **bcrypt hash** (cost ~12), never plaintext; salt is
   inside the hash.
2. `JWT_SECRET` from a Railway env var, high-entropy, never in git.
3. Login returns an **identical 401** for unknown-email and wrong-password, and
   runs bcrypt in **both** cases (no timing leak).
4. `jwt.decode` always pins `algorithms=["HS256"]` — never trust the token's own
   `alg` header.
5. Token carries `sub` (= `user_id`) and `exp`; expiry enforced on every decode.
6. `require_auth` dependency on **every** data route; `user_id` from the token
   drives the `WHERE user_id` filter.
7. Served only over HTTPS (Railway provides it) so the bearer token isn't sniffed
   in transit.

## Migration note (if this ever goes public-ish)

The hand-rolled layer is intentionally small, so hardening later is additive, not
a rewrite: add signup + email verification, swap `localStorage` for `httpOnly`
cookies + CSRF, add login rate-limiting, and introduce refresh-token rotation.
The `users` table and the `sub`-drives-`WHERE user_id` pattern already carry
forward unchanged — same seam as the rest of the design.
