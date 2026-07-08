# Architecture

A single-user personal-finance app: bank accounts are linked through
[Plaid](https://plaid.com), transactions sync into Postgres, and a Next.js
ledger UI reads the result. Backend (FastAPI + a nightly sync cron), database,
and frontend all run on Railway; the database is reachable only over the
private network.

## The life of a transaction

How a purchase at your bank becomes a row in the ledger — four services, one
story. Step numbers follow the sequence; each color is one arc of the story:
**link a bank** (1–6, once per bank), **sync** (7–11, continuous),
**refresh** (12–15, on demand), **read** (16–17, every page view).

![Sequence diagram: frontend, backend, database and Plaid API exchanging messages to link a bank, sync transactions, refresh on demand, and read the ledger](./transaction-flow.svg)

Also available as a standalone page: [transaction-flow.html](./transaction-flow.html).

## The invariants the diagram enforces

- **No tokens in the browser.** The browser meets Plaid exactly once — inside
  Plaid Link (step 3). Every data call happens on the backend, using an
  `access_token` that is encrypted at rest (Fernet) and never returned by any
  endpoint.
- **Reprocess, never skip.** Added, modified and removed transactions all land
  in one database transaction, and the sync cursor is written strictly last
  (step 11) — a crash anywhere replays cleanly instead of losing data.
- **Safe to re-run.** A per-item Postgres advisory lock (step 9) arbitrates
  when the webhook and the cron race; the nightly cron re-syncs every bank as
  an idempotent backstop; the on-demand refresh claims its cooldown with one
  atomic `UPDATE` (step 13), so retries and second tabs can't double-bill.
