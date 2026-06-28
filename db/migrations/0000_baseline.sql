-- 0000_baseline — Phase 0
-- Deliberately empty: its only job is to prove the migration runner applies a
-- file in order, records it in schema_migrations, and is clean to re-run.
-- The real schema (items, accounts, transactions, users, ...) lands in
-- 0001_initial_schema.sql in Phase 1.
DO $$ BEGIN END $$;
