-- Manual /transactions/refresh cooldown. One user-level stamp (not per-item):
-- enforcement is global per user — the endpoint claims it atomically before any
-- Plaid I/O. Rewritten pre-merge (never applied outside local sandboxes) from a
-- per-item column; idempotent both ways so a sandbox that ran the old version
-- converges.
ALTER TABLE items DROP COLUMN IF EXISTS last_manual_refresh_at;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_manual_refresh_at timestamptz;
