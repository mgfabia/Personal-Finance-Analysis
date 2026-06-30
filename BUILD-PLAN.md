# Personal Finance App — Build Roadmap (Phases)

Companion to [`personal-finance-rebuild-architecture.md`](./personal-finance-rebuild-architecture.md).
That doc decides *what* and *why*; this one decides *the order to build it in and why
that order*. It groups the spec's 9-step build order and the v1 must-fix checklist
into a small number of large phases, each with a single clear milestone — plus one
learning-first throwaway slice (Phase S) that isn't in the spec's order.

## Session decisions (locked)

- **Deliverable of this session:** this roadmap document only — no code yet.
- **Frontend:** Next.js (React) — pairs with `react-plaid-link`; hand-rolled sign-in.
- **Repo layout:** monorepo — `/backend` (FastAPI; SQL migrations in `backend/db`), `/frontend` (Next.js).
- **Dev environment:** hosted Plaid Sandbox; local Postgres in Docker for the dev
  inner loop; separate Railway environments (prod + staging), each with its own
  Postgres. *(Supersedes the earlier "no local DB" note — per-environment DB
  isolation.)*

---

## Revision — build-order reprioritization (2026-06-30)

**This section overrides the phase *sequence* below where they conflict. Phase
*numbers* are unchanged — they stay as stable IDs referenced across the codebase
(migrations, `CLAUDE.md`, memory). What changes is the order in which the remaining
phases are built.**

**Decision:** with Phases 0–4 deployed and validated on prod, pull **auth and the
frontend forward** and **push the remaining-product sync routines (Phase 5) to last**
among the feature work. Rationale: Phase 5 is pure repetition of a proven pattern
(Principle 4) — it adds data breadth but no new capability the app can't demo
without. A usable, authenticated web app that shows real transactions is higher
value than four more raw sync routines feeding views nobody can see yet.

**This works because Phase 7 splits along its dependencies** — only one slice of it
needs Phase 5:

- **7a — auth + transaction read API/views** (login, `require_auth`, JWT; the
  transaction/monthly/category/weekly views and their read endpoints). Depends only
  on Phase 3 data, which exists. *Buildable now.* Also retires the interim
  `X-API-Key` guard currently on the Plaid write endpoints.
- **7b — net-worth view** (balances + holdings − liabilities). Needs rows that only
  exist after Phase 5. *Deferred until after Phase 5.*

And Phase 8 splits similarly: sign-in + transactions view + Link-add-a-bank are
buildable now; the **reconnect banner** depends on Phase 6 (re-auth backend), not
Phase 5.

**Revised build order (remaining phases):**

1. **7a** — hand-rolled auth + transaction read API/views (replaces the `X-API-Key`
   guard).
2. **8 (core)** — frontend: sign-in + transactions view + Link add-a-bank.
3. **5** — remaining product sync routines (balances, recurring, investments,
   liabilities).
4. **7b** — net-worth view, backfilled now that its inputs exist.
5. **6** — re-auth & reconnect backend, then **8 (reconnect banner)**.
6. **9** — production cutover.

**Coupling to remember:** `require_auth` (built in 7a) must gate every write
endpoint. Phase 6 adds *new* Link/write endpoints later — gate them as they're built,
or re-sweep auth onto them after Phase 6. This is the one ordering hazard the
reorder introduces.

---

## Ordering principles (the "why" behind the sequence)

These five rules decide what comes before what. Every phase ordering below traces
back to one of them.

1. **Correctness spine before features.** The two things that are *expensive to
   retrofit* are the account-identity model (§3: account = identity, item =
   provenance) and the transactional sync loop (§2: added/modified/removed,
   cursor-last). Anything written into the wrong key shape, or any sync that drops
   `removed`, corrupts data that later phases build on. So the schema and the sync
   transaction come first, not the features.
2. **One thin vertical slice early.** Link → store `access_token` → run one sync is
   the slice that proves the Plaid round-trip *and* the non-negotiable security
   invariant (browser never sees the secret/token). Prove it on one product before
   adding breadth.
3. **Reconciler before real-time.** The nightly cron-driven `runSync` is the
   durability safety net; webhooks are a near-real-time optimization layered on top
   of it. Build the thing that is correct on its own (cron) first, then make it
   fast (webhooks). This also lets idempotency be validated without webhook
   plumbing in the way.
4. **Breadth after the pattern is proven.** The other four products
   (balances, recurring, investments, liabilities) are the same lock-and-upsert
   shape repeated. They are volume, not new architecture — so they come after the
   engine and concurrency model are proven on transactions.
5. **Consumers last (stay in the layer).** SQL views, then read API, then frontend.
   Views need real rows to validate against; the UI consumes stable read endpoints.
   Backend correctness is finished on its own terms before a consumer is built.

---

## Phase map at a glance

| Phase | Milestone (done = …) | Unblocks | Key spec refs |
|---|---|---|---|
| **0 — Foundations** | Accounts, secrets, monorepo skeleton, migration tooling exist | everything | locked stack |
| **S — Walking skeleton** *(learning-first, throwaway)* | Ugly end-to-end slice: login → link 1 Sandbox bank → one sync → bare Next.js page | learning cadence | §Build order |
| **1 — Data model** | Schema migrated; identity/provenance + item-health keys correct | 2–7 | §Data model, §3 |
| **2 — Link & item storage** | A Sandbox item linked; `access_token` stored encrypted; accounts reconciled | 3,4,5,6 | §Plaid interaction model |
| **3 — Transactions sync engine** | `runSync` cron-driven, locked, transactional, idempotent | 4,5,6,7 | §Sync strategy, §1, §2 |
| **4 — Webhooks & item health** | Verified webhooks trigger sync; ITEM webhooks set status | 6 | §Webhook reqs, §Item health |
| **5 — Remaining products** | Balances/recurring/investments/liabilities sync | 7 | §Plaid product scope |
| **6 — Re-auth & reconnect** | Update-mode + revoked branches; unhealthy-item email digest | 8 | §Item health, §4 |
| **7 — Views, auth & read API** | SQL views + hand-rolled auth + auth-gated read endpoints serve data | 8 | §Data model (derived), §Hand-rolled auth |
| **8 — Frontend** | Sign-in, read views, Link add/relink, reconnect banner | — | §Components (1) |
| **9 — Production cutover** | Live on Plaid Production with cost-confirmed product set | — | §Open decisions |

**Critical path (production correctness):** 0 → 1 → 2 → 3 → (4 ∥ 5) → (6 ∥ 7) → 8 → 9.
Phases 4 and 5 can overlap once Phase 3 lands (both reuse `runSync`/the lock
pattern). Phases 6 and 7 are independent and can also overlap — 6 needs item-health
(4) + the reconciliation fn (2); 7 needs synced data (3) + the remaining products
(5) for the net-worth view. One caveat: Phase 7's `require_auth` retrofit must cover
the Link/write endpoints from Phases 2 and 6, so finish 6's endpoints before 7's
auth sweep (or re-sweep after).

> **Superseded for the actual build sequence** by the *Revision —
> build-order reprioritization (2026-06-30)* section above: auth (7a) and the
> frontend are pulled ahead of Phase 5, which moves to last among the feature work.
> The critical-path *dependency graph* here is still accurate (what each phase needs);
> only the chosen traversal order changed.

**Learning-first detour:** 0 → **S** → then back to 1. Phase S is a *throwaway*
vertical slice built right after Foundations, before any deep work; its code is
replaced or deepened by Phases 1–8. It sits off the production critical path on
purpose — its only job is to put the whole full-stack shape in your head early.

---

## Phase 0 — Foundations

**Goal:** the project can hold code and secrets and version the database. Keep it
thin — no business logic.

- Monorepo skeleton: `/backend` (FastAPI; SQL migrations in `backend/db`),
  `/frontend` (Next.js), `/scripts` (ops), shared `README`/tooling. *(Migrations
  live under `backend/` so they ship in the backend's Railway build context.)*
- Create the **Railway** project with two services: the FastAPI backend and a
  **self-hosted Postgres** container on the project's private network; obtain
  **Plaid Sandbox** client_id/secret.
- Secret handling: Railway env vars in prod; local `.env` (git-ignored) for dev.
  Decide the `access_token` encryption key and the `JWT_SECRET` now (env-provided),
  even before they're used.
- Migration runner against Railway Postgres (plain SQL files in `backend/db/migrations`, applied in
  order). This is the mechanism every later schema/view change rides on.
- Wire the nightly `pg_dump` to off-Railway storage now — I own backups (finance app).

**Exit criteria:** `backend` boots and reaches Railway Postgres over the private
network (`DATABASE_URL`); an empty migration applies cleanly; secrets resolve from
env in both local and Railway.

**Why first:** nothing runs without accounts, secrets, and a place to put
migrations. (Principle: prerequisite, not a principle trade-off.)

---

## Phase S — Walking skeleton (learning-first vertical slice)

**Goal:** one deliberately ugly end-to-end slice that touches every layer —
frontend, auth, API, Plaid, DB — *before* deepening any of them. The point is to
learn the integration seams (where full-stack is actually hard) and to see real
bank data in a browser in week one.

**The slice (and nothing more):**

- A throwaway login — even a single hard-coded password → a JWT, enough to gate
  one page. Do **not** build the full hand-rolled auth here; that's Phase 7.
- A minimal Link flow: `/link/token/create` + `/item/public_token/exchange`;
  store the `access_token` **encrypted** (that habit starts now).
- One sync call: `/transactions/sync` once — ignore `has_more` looping, the
  advisory lock, the `removed` set, and cursor-correctness (all Phase 3).
- **Throwaway storage:** a couple of crude tables (or even just dump the JSON) —
  **not** the Phase 1 identity schema, which doesn't exist yet. The real tables
  arrive in Phase 1 and this storage gets discarded.
- A bare Next.js page that logs in, runs Plaid Link on a Sandbox bank, and
  renders the returned transactions as an unstyled table. No views, no other
  products, no styling.

**Exit criteria:** signed in from a browser, you link a Sandbox bank and see its
transactions on a page — every layer exercised once, end to end.

**Explicitly throwaway.** This bends Principle 5 ("consumers last") *on purpose*,
and only here. None of this is the real implementation — each piece is replaced
or deepened by Phases 1–8 (proper identity schema, locked/transactional sync,
real auth, SQL views). Resist polishing it.

**Why here:** for a full-stack *learning* goal, touching all layers early beats a
perfect backend with no UI for weeks. It's Principle 2 ("one thin vertical slice
early") taken through the frontend, not stopped at the API.

---

## Phase 1 — Data model (the correctness foundation)

**Goal:** the raw schema, with the identity model and item-health columns correct
*from the first migration* — because these keys are the most expensive thing to
change later.

- Raw tables, every one carrying **`user_id` from day one**: `items`, `accounts`,
  `transactions`, `recurring_streams`, `holdings`, `securities`,
  `investment_transactions`, `liabilities`.
- **Identity model (§3) + item-health columns (§Item health) baked in, not retrofitted:**
  - `items` = the Plaid login session, **transient**; carries
    `status` / `last_synced_at` / `last_error` and `transactions_cursor`.
  - `accounts` anchored on Plaid **`persistent_account_id`**, with
    `current_item_id` FK → whichever item currently owns the login.
  - `transactions` keyed to the **account**, not the item.
- App tables: `users` (hand-rolled — `id` uuid, `email`, `password_hash` bcrypt,
  `created_at`; every data table's `user_id` references `users.id`, no `auth.users`
  FK) and `transaction_overrides` (manual edits, later LEFT JOIN'd into views).
- `access_token` column typed/encrypted-at-rest on `items`.

**Exit criteria:** all raw tables + app tables (`users`, `transaction_overrides`)
exist via migrations; FKs encode "account = identity, item = provenance"; the
`user_id` → `users.id` reference resolves; re-running migrations is clean.

**Why here (Principle 1):** §3's identity model and the item-health columns must
exist before any row is written, or a later revoke/re-link fractures history.
Get the keys right before any data lands in them.

---

## Phase 2 — Link flow & item storage (first Plaid contact)

**Goal:** the *production* Link & item-storage path (Phase S already proved the
round-trip; this builds it properly) — a real Sandbox item linked, its
`access_token` stored encrypted server-side, its accounts reconciled into
`accounts` (the real Phase 1 schema this time, not throwaway tables).

- Backend endpoints: `POST /link/token/create`, `POST /item/public_token/exchange`.
- On exchange: receive `access_token`, **encrypt and store server-side**; pull the
  item's accounts and **run the account-reconciliation function** — match each
  account by `persistent_account_id`, insert new ones, re-point existing ones'
  `current_item_id`. (Built here because exchange is where accounts first land; §3
  reuse later in re-auth.)
- Frontend stub only as needed to drive the Sandbox Link handshake (full UI is
  Phase 8).

**Exit criteria:** a Sandbox bank is linked end-to-end; `items` + `accounts`
populated; the browser never received the `access_token` or Plaid secret
(security invariant holds).

**Why here (Principle 2):** every sync routine needs a stored `access_token` and
known accounts. This is where the *real*, reconciled storage lands — the security
invariant (first shown throwaway in Phase S) is now enforced for keeps, before any
breadth is added.

---

## Phase 3 — Transactions sync engine (core engine + concurrency correctness)

**Goal:** `runSync(itemId, products)` exists as an internal backend function, is
concurrency-safe and transactionally correct, and runs on the nightly cron.

- **Per-item lock (§1):** wrap `runSync` in
  `pg_try_advisory_lock(hashtext(item_id))` — non-blocking `try` variant so the
  cron *skips* an item already syncing rather than queuing. Acquire **before** Plaid
  I/O; open the DB write transaction only at the end; release in `finally`.
- **Transactional sync loop (§2):** loop `/transactions/sync` until `has_more` is
  false, accumulating **added / modified / removed**. In one DB transaction: upsert
  added+modified, delete/tombstone removed, then write the new
  `transactions_cursor` — **cursor strictly last**. Failure mode is always
  "reprocess," never "skip."
- **Railway cron** invocation (separate scheduled process / distinct start command)
  calls `runSync` for every item. This is the durability backbone.

**Exit criteria:** cron runs `runSync` over the linked item; re-running produces no
duplicates and no ghost rows; a forced concurrent run is cleanly skipped by the
advisory lock; cursor only advances after rows are durably written.

**Why here (Principles 1 & 3):** the cron-driven, idempotent engine is what makes
the later fire-and-forget webhook handler *safe*. Build and prove it before
real-time triggers exist.

---

## Phase 4 — Webhooks & item health (real-time layer)

**Goal:** verified Plaid webhooks drive the same `runSync`, and item-level webhooks
maintain `items.status`.

- Public HTTPS webhook endpoint (Railway-provided URL).
- **Verify every webhook:** validate the JWT in `Plaid-Verification` against
  `/webhook_verification_key/get`; reject on failure.
- **Thin handler:** verify → record "sync needed for item X" (or status change) →
  return `200` immediately → run work asynchronously. Never sync inline.
- Branch: `SYNC_UPDATES_AVAILABLE` → enqueue `runSync`; **ITEM** webhooks
  (`ITEM_LOGIN_REQUIRED`, `PENDING_EXPIRATION`, `ERROR`) → update `items.status`.
- **Sync-failure safety net:** when a sync gets `ITEM_LOGIN_REQUIRED`, set
  `status = login_required` and stop — covers a missed ITEM webhook.

**Exit criteria:** a Sandbox `SYNC_UPDATES_AVAILABLE` fires `runSync`; an ITEM
webhook flips `status`; unverified webhooks are rejected; handler always returns
fast.

**Why here (Principle 3):** webhooks only *trigger* the Phase 3 engine — building
them after proving that engine keeps them thin and means a missed webhook is at
most a day of lag, never lost data.

---

## Phase 5 — Remaining product sync routines

**Goal:** balances, recurring, investments, liabilities sync via the proven
lock-and-upsert shape. Can overlap Phase 4.

- **Balances:** cron-driven cached `/accounts/get`; reserve `/accounts/balance/get`
  (fresh, costlier) for an explicit on-demand "refresh now". No webhook.
- **Recurring:** `/transactions/recurring/get` (+ `RECURRING_TRANSACTIONS_UPDATE`).
- **Investments:** `/investments/holdings/get`, `/investments/transactions/get`
  (+ `HOLDINGS`, `INVESTMENTS_TRANSACTIONS`).
- **Liabilities:** `/liabilities/get` (+ liabilities `DEFAULT_UPDATE`).
- Each runs under the same advisory lock; none has a cursor or removed-set, so they
  follow the simpler lock-and-upsert form.

**Exit criteria:** all four products upsert raw rows on cron (and on their webhooks
where applicable); each is idempotent.

**Why here (Principle 4):** pure repetition of a proven pattern — volume, not new
architecture, so it comes after the engine is trusted.

---

## Phase 6 — Re-auth & reconnect

**Goal:** broken items can be repaired, and an unhealthy item is surfaced.

- **Update-mode token (§4):** `POST /link/token/create` *with* the existing
  `access_token` → puts Link in update mode for that item. In update mode there's
  **no public_token to exchange**; frontend `onSuccess` POSTs a "item X repaired"
  ping so the backend flips `status = healthy` and triggers a sync.
- **Revoked branch (§4):** `revoked` → fresh Link (new item) → run the Phase 2
  account-reconciliation step to re-point existing `accounts.current_item_id` onto
  the new item (history stays attached → net worth continuous). Retire the dead
  item row.
- **Email digest:** at the **end of the nightly cron**, if any item is non-healthy,
  send one summary email (not per-failure, not from the webhook handler).

**Exit criteria:** a Sandbox `login_required` item repairs in place via update mode
and clears its status; a revoked item re-links and re-points accounts without
fracturing history; cron emails one digest when something is unhealthy.

**Why here:** depends on item-health (Phase 4) and the reconciliation function
(Phase 2). Reuses the existing Link integration — minimal new surface.

---

## Phase 7 — SQL views, auth & read API

**Goal:** business logic expressed as plain SQL views, exposed through auth-gated
read endpoints. Backend is now complete on its own terms.

- **Views (migrations):** account-based transaction classification (carry over
  existing logic), monthly/weekly summaries, category rollups, recurring
  monthly-equivalent, and **net worth = balances + holdings − liabilities**.
  `transaction_overrides` LEFT JOIN'd so manual edits survive re-syncs.
  Computed-on-read; promote a single view to materialized only if it ever gets slow.
- **Hand-rolled auth backend:** `POST /auth/login` (bcrypt-check the password
  against `users.password_hash`, mint an HS256 session JWT carrying `sub` = user_id
  + `exp`) and a `require_auth` dependency (pin `algorithms=["HS256"]`, enforce
  expiry, return `sub`). The dependency gates API routes and is also retrofitted
  onto the Link/write endpoints from Phases 2/6. See the spec's hand-rolled auth
  section for the full failure-mode reasoning.
- **Read endpoints** served from the views: `/api/transactions`, `/balances`,
  `/holdings`, `/recurring`, net-worth, etc. `user_id` from the verified token
  drives every `WHERE user_id` filter.

**Exit criteria:** views return correct results against real synced data; read
endpoints require a valid session JWT and serve from views (not raw tables);
login returns an identical 401 for unknown-email and wrong-password.

**Why here (Principle 5):** views need real rows to validate; the read API is the
stable contract the frontend will consume. Backend correctness finished before any
UI exists.

---

## Phase 8 — Frontend (Next.js)

**Goal:** the web app — sign in, see data, link/relink banks.

- **Hand-rolled sign-in:** POST `/auth/login`, store the returned JWT
  (`localStorage` for v1 — private single-user app), attach it as
  `Authorization: Bearer <token>` on every read call.
- Data views (transactions, balances, holdings, recurring, net worth) from the
  Phase 7 read API.
- **Plaid Link** (`react-plaid-link`) to add a bank (Phase 2 flow) and to relink.
- **Reconnect banner (§4) — two branches:** `login_required`/`pending_expiration`
  → update mode; `revoked` → fresh Link. This banner *is* the re-auth UI; its
  update-mode `onSuccess` fires the Phase 6 "repaired" ping.
- **Hosting (open decision):** deploy target is **Vercel vs Railway** — see spec
  §Remaining open decisions. Decide before this phase; it affects nothing earlier.

**Exit criteria:** user signs in and sees their data; can link a new Sandbox bank;
an unhealthy item shows the correct banner and reconnect path clears it.

**Why last (Principle 5):** consumes everything below it; per "stay in the layer,"
the backend was designed for correctness independent of this consumer.

---

## Phase 9 — Production cutover

**Goal:** go live on Plaid Production at controlled cost.

- Confirm current **per-product-per-Item** pricing / free allotment on Plaid's
  pricing page (the one remaining open decision in the spec).
- Enable in Production **only the products actually looked at**; keep the rest in
  Sandbox.
- Swap Plaid env + keys to Production via Railway secret env vars; re-link items
  against Production.

**Exit criteria:** app runs against Plaid Production with a cost-confirmed product
set; items linked; nightly cron + webhooks healthy in prod.

---

## v1 must-fix checklist → phase mapping

The spec's four must-fix items are not a late hardening pass; each is built into
the phase where its surface first appears:

| Must-fix (spec §§1–4) | Built in |
|---|---|
| `pg_try_advisory_lock(hashtext(item_id))` around `runSync` | **Phase 3** |
| `added`/`modified`/`removed`; cursor written last, same txn | **Phase 3** |
| account = identity (`persistent_account_id`), item = provenance | **Phase 1** (schema) + **Phase 2** (reconciliation fn) |
| reconnect banner branches; update-mode `onSuccess` pings backend | **Phase 6** (backend) + **Phase 8** (banner UI) |

## Cross-cutting concerns (true throughout)

- **Security invariant:** browser never sees the Plaid secret/`access_token` and
  never calls a Plaid data endpoint. Holds from Phase 2 onward; re-checked at every
  phase that touches Plaid.
- **Idempotency:** every sync routine must be safe to re-run (the cron depends on
  it). Established in Phase 3, required of Phase 5's routines.
- **`user_id` everywhere:** single-user today, but every data table carries it from
  Phase 1 so "public-ish someday" stays cheap.
- **One-vendor boundary:** Railway Postgres is just Postgres (no auto-REST layer, no
  edge functions, no auth product); all Plaid logic and all auth stay in FastAPI.
  Backend ↔ Postgres over the Railway private network (`DATABASE_URL`); the DB is not
  publicly exposed.
- **Hand-rolled auth invariants:** bcrypt password hash (never plaintext);
  `JWT_SECRET` from env, never in git; `jwt.decode` always pins
  `algorithms=["HS256"]`; `require_auth` on every data route.
- **Backups:** nightly `pg_dump` off Railway — I own this now (finance app).
