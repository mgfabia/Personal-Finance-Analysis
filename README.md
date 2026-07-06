# Personal-Finance-Analysis

A self-hosted personal-finance web app: link your bank accounts via **Plaid**,
sync transactions into your own **Postgres**, and explore them in a **Next.js**
dashboard served by a **FastAPI** backend. Single-user by design, built so the
data model scales past that.

## How it works

- **Plaid Link → encrypted storage.** The browser talks to Plaid only through
  Plaid Link; access tokens are exchanged backend-side and Fernet-encrypted at
  rest. The frontend never sees a Plaid secret or token.
- **Idempotent sync engine.** A nightly cron (plus verified Plaid webhooks for
  near-real-time updates) drains `/transactions/sync` under a Postgres advisory
  lock, applying added/modified/removed and the cursor in one transaction — the
  failure mode is always "reprocess," never "skip."
- **Accounts are identity, bank logins are provenance.** Re-linking a bank
  re-points accounts to the new login instead of fracturing transaction history.
- **Hand-rolled single-user auth.** bcrypt password + HS256 session JWT, with
  enumeration/timing defenses and a login rate limit. No third-party auth
  dependency.
- **Owned operations.** Plain SQL migrations applied by a small runner, JSON
  logs, and nightly `pg_dump` backups encrypted with [age](https://age-encryption.org)
  to any S3-compatible bucket.

## Stack & layout

Python / FastAPI · Postgres · Next.js (App Router, Tailwind, Recharts) ·
deployed on Railway; works anywhere you can run a container and a Postgres.

```
/backend     FastAPI app: Plaid link/exchange, sync engine, webhooks, auth, read API
  /db        Plain .sql migrations (see backend/db/README.md)
/frontend    Next.js dashboard (login, KPIs, charts, transactions table)
/scripts     Ops: nightly encrypted pg_dump backup
```

## Quick start (local)

Requires Docker, Python 3.12+, Node 20+, and free [Plaid Sandbox](https://dashboard.plaid.com/signup) keys.

```bash
docker compose up -d                          # disposable local Postgres

cd backend
cp .env.example .env                          # fill in Plaid keys + generated secrets
python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
python -m app.migrate                         # apply schema
python -m app.set_password                    # set your login password
uvicorn app.main:app --reload                 # API on :8000

cd ../frontend
cp .env.example .env.local
npm install && npm run dev                    # UI on :3000
```

Log in, click **Add bank**, pick any Sandbox institution (`user_good` /
`pass_good`), then run `python -m app.sync` to pull transactions.

## License

[MIT](./LICENSE) — use, copy, modify, and redistribute freely; attribution
required, no warranty.
