# `backend/db` — database migrations

Plain `.sql` files, applied **in lexical order** by the runner in
[`app/migrate.py`](../app/migrate.py). This is the single mechanism every schema
and view change rides on. They live under `backend/` (not a top-level `/db`) so
they ship inside the backend service's Railway build context.

## Conventions

- **Filename = version**: `NNNN_short_description.sql` (zero-padded numeric
  prefix). Order is the prefix; keep them globally increasing.
- **Migrations are immutable once applied.** The runner stores a checksum; if
  an already-applied file changes it refuses to run (checksum drift). To change
  the schema, add a *new* migration — never edit a shipped one.
- **One concern per file** where practical; each file runs in its own
  transaction and is recorded atomically with its own application.
- **Forward-only.** No down-migrations (single-user app; restore from the
  nightly `pg_dump` if a migration must be undone — see `/scripts`).

## Running

From `backend/` with `DATABASE_URL` set (env or `.env`):

```bash
python -m app.migrate            # apply all pending migrations
python -m app.migrate --status   # show applied vs pending, apply nothing
```

Re-running with nothing pending is a clean no-op (exit 0).

## Files

- `0000_baseline.sql` — empty; proves the runner (Phase 0).
- `0001_initial_schema.sql` — raw + app tables, identity/provenance + item
  health (Phase 1).
