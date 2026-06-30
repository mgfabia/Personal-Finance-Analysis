-- 0001_initial_schema — Phase 1 (Data model)
--
-- The correctness foundation. Identity/provenance (§3) and item-health (§Item
-- health) keys are baked in here, not retrofitted — these are the most expensive
-- things to change once data lands.
--
-- Invariants enforced by this schema:
--   * §4 / inv. 4  — account = identity, item = provenance. `accounts` anchor on
--                    Plaid's `persistent_account_id`; `transactions` key to the
--                    ACCOUNT, never the item (there is deliberately no item_id on
--                    `transactions`). `items.id` is only a provenance pointer via
--                    `accounts.current_item_id`, re-pointed on re-link.
--   * inv. 6      — every data table carries `user_id` from day one, referencing
--                    the local `users` table (no external auth FK).
--   * §2          — `transactions.removed_at` lets Phase 3 tombstone the `removed`
--                    set instead of dropping history.
--
-- Conventions:
--   * Internal `uuid` surrogate PKs (gen_random_uuid()); Plaid IDs are unique
--     natural keys alongside them.
--   * Raw tables are "dumb": the columns views/joins need are lifted into typed
--     columns, and the full Plaid payload is kept in a `raw jsonb` passthrough so
--     no field is ever lost and new fields need no migration to read.
--   * Money: numeric(20,4). Quantities/prices: numeric(28,10) (fractional shares).
--   * created_at/updated_at on every table; updated_at maintained by a trigger.

-- gen_random_uuid() is core in PG13+. citext gives case-insensitive email.
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- updated_at maintenance — one trigger function reused by every table.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- App tables
-- ===========================================================================

-- users — hand-rolled auth (Phase 7 fills the login path). One row today; every
-- data table's user_id references this. password_hash is a bcrypt hash.
CREATE TABLE users (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    email         citext      NOT NULL UNIQUE,
    password_hash text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- Raw tables (upsert on sync)
-- ===========================================================================

-- items — one Plaid login session per linked bank. PROVENANCE, not identity:
-- transient, replaced/retired on revoke+re-link. Carries the encrypted
-- access_token, the transactions cursor, and the item-health columns (§Item
-- health). `plaid_item_id` is the hashtext() advisory-lock target in Phase 3.
CREATE TABLE items (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    plaid_item_id          text        NOT NULL UNIQUE,
    plaid_institution_id   text,
    institution_name       text,

    -- Fernet ciphertext only — never plaintext (inv. 1 / security model).
    -- Written in Phase 2; nullable so a row can exist mid-link if ever needed.
    access_token_encrypted text,

    transactions_cursor    text,                       -- null = never synced
    products               text[]      NOT NULL DEFAULT '{}',

    -- Item health (§Item health). status drives the reconnect banner branches.
    status                 text        NOT NULL DEFAULT 'healthy'
        CHECK (status IN ('healthy', 'login_required', 'pending_expiration', 'revoked')),
    last_synced_at         timestamptz,
    last_error             jsonb,                      -- {error_code, error_message}

    retired_at             timestamptz,                -- §3: soft-retire dead items on re-link

    raw                    jsonb,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX items_user_id_idx ON items (user_id);
CREATE INDEX items_status_idx  ON items (status) WHERE retired_at IS NULL;
CREATE TRIGGER items_set_updated_at BEFORE UPDATE ON items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- accounts — IDENTITY (§3). Anchored on Plaid's persistent_account_id, which
-- survives re-linking. current_item_id points at whichever item currently owns
-- the login and is re-pointed on re-link so history never fractures.
--
-- Reality caveat: persistent_account_id is null for most institutions, so it
-- cannot be the sole key. We keep both: plaid_account_id (per-item, changes on
-- re-link) is the working natural key; persistent_account_id is a stable anchor
-- when present. The Phase 2 reconciliation fn prefers persistent_account_id and
-- falls back to (mask, type, subtype, name) when it is null.
CREATE TABLE accounts (
    id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    current_item_id       uuid        NOT NULL REFERENCES items(id) ON DELETE RESTRICT,

    plaid_account_id      text        NOT NULL,
    persistent_account_id text,                        -- nullable; stable when Plaid provides it

    name                  text,
    official_name         text,
    mask                  text,
    type                  text,                        -- depository/credit/loan/investment
    subtype               text,
    currency              text,                        -- iso_currency_code

    current_balance       numeric(20,4),
    available_balance     numeric(20,4),
    credit_limit          numeric(20,4),
    balance_last_updated  timestamptz,

    raw                   jsonb,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),

    UNIQUE (user_id, plaid_account_id)
);
-- persistent_account_id is unique per user only when present.
CREATE UNIQUE INDEX accounts_persistent_id_uniq
    ON accounts (user_id, persistent_account_id)
    WHERE persistent_account_id IS NOT NULL;
CREATE INDEX accounts_current_item_id_idx ON accounts (current_item_id);
CREATE INDEX accounts_user_id_idx         ON accounts (user_id);
CREATE TRIGGER accounts_set_updated_at BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- transactions — keyed to the ACCOUNT (inv. 4). There is intentionally NO
-- item_id column: provenance lives on the account. removed_at tombstones the
-- §2 `removed` set; views filter WHERE removed_at IS NULL.
CREATE TABLE transactions (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    account_id             uuid        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,

    plaid_transaction_id   text        NOT NULL UNIQUE,
    pending                boolean     NOT NULL DEFAULT false,
    pending_transaction_id text,                       -- links a pending txn to its posted form

    amount                 numeric(20,4) NOT NULL,
    currency               text,
    date                   date        NOT NULL,
    datetime               timestamptz,

    name                   text,
    merchant_name          text,
    payment_channel        text,
    account_owner          text,

    -- Personal Finance Category (lifted for views) + legacy category hierarchy.
    pfc_primary            text,
    pfc_detailed           text,
    category               text[],

    removed_at             timestamptz,                -- §2 tombstone (null = live)

    raw                    jsonb,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transactions_account_date_idx ON transactions (account_id, date DESC)
    WHERE removed_at IS NULL;
CREATE INDEX transactions_user_id_idx      ON transactions (user_id);
CREATE INDEX transactions_pending_ref_idx  ON transactions (pending_transaction_id)
    WHERE pending_transaction_id IS NOT NULL;
CREATE TRIGGER transactions_set_updated_at BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- transaction_overrides — manual edits, LEFT JOIN'd into views so they survive
-- re-syncs. Keyed to our stable internal transactions.id; one override per txn.
CREATE TABLE transaction_overrides (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    transaction_id    uuid        NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,

    category_override text,
    name_override     text,
    notes             text,
    is_hidden         boolean     NOT NULL DEFAULT false,
    tags              text[]      NOT NULL DEFAULT '{}',

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transaction_overrides_user_id_idx ON transaction_overrides (user_id);
CREATE TRIGGER transaction_overrides_set_updated_at BEFORE UPDATE ON transaction_overrides
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- recurring_streams — recurring inflow/outflow streams (/transactions/recurring/get).
CREATE TABLE recurring_streams (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    account_id      uuid        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,

    plaid_stream_id text        NOT NULL UNIQUE,
    direction       text,                              -- INFLOW / OUTFLOW
    status          text,                              -- MATURE / EARLY_DETECTION / TOMBSTONED ...
    description     text,
    merchant_name   text,
    frequency       text,
    average_amount  numeric(20,4),
    last_amount     numeric(20,4),
    currency        text,
    first_date      date,
    last_date       date,
    is_active       boolean,
    pfc_primary     text,
    pfc_detailed    text,

    raw             jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recurring_streams_account_id_idx ON recurring_streams (account_id);
CREATE INDEX recurring_streams_user_id_idx    ON recurring_streams (user_id);
CREATE TRIGGER recurring_streams_set_updated_at BEFORE UPDATE ON recurring_streams
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- securities — investment security reference data (shared across holdings and
-- investment_transactions). Carries user_id per inv. 6 even though it is
-- reference-like.
CREATE TABLE securities (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    plaid_security_id   text        NOT NULL UNIQUE,
    name                text,
    ticker_symbol       text,
    cusip               text,
    isin                text,
    type                text,
    close_price         numeric(28,10),
    close_price_as_of   date,
    currency            text,
    is_cash_equivalent  boolean,

    raw                 jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX securities_user_id_idx ON securities (user_id);
CREATE TRIGGER securities_set_updated_at BEFORE UPDATE ON securities
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- holdings — current investment holdings (/investments/holdings/get). No Plaid
-- natural id; identity is (account, security).
CREATE TABLE holdings (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    account_id             uuid        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    security_id            uuid        NOT NULL REFERENCES securities(id) ON DELETE RESTRICT,

    quantity               numeric(28,10),
    institution_price      numeric(28,10),
    institution_price_as_of date,
    institution_value      numeric(20,4),
    cost_basis             numeric(20,4),
    currency               text,

    raw                    jsonb,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),

    UNIQUE (user_id, account_id, security_id)
);
CREATE INDEX holdings_account_id_idx  ON holdings (account_id);
CREATE INDEX holdings_security_id_idx ON holdings (security_id);
CREATE TRIGGER holdings_set_updated_at BEFORE UPDATE ON holdings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- investment_transactions — buys/sells/fees etc. (/investments/transactions/get).
CREATE TABLE investment_transactions (
    id                                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                           uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    account_id                        uuid        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    security_id                       uuid        REFERENCES securities(id) ON DELETE RESTRICT,

    plaid_investment_transaction_id   text        NOT NULL UNIQUE,
    type                              text,
    subtype                           text,
    name                              text,
    quantity                          numeric(28,10),
    amount                            numeric(20,4),
    price                             numeric(28,10),
    fees                              numeric(20,4),
    currency                          text,
    date                              date,

    raw                               jsonb,
    created_at                        timestamptz NOT NULL DEFAULT now(),
    updated_at                        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX investment_transactions_account_date_idx ON investment_transactions (account_id, date DESC);
CREATE INDEX investment_transactions_security_id_idx  ON investment_transactions (security_id);
CREATE INDEX investment_transactions_user_id_idx      ON investment_transactions (user_id);
CREATE TRIGGER investment_transactions_set_updated_at BEFORE UPDATE ON investment_transactions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- liabilities — credit/loan details (/liabilities/get). Plaid returns three
-- shapes (credit / mortgage / student); we lift the common payment fields and
-- keep the shape-specific detail in raw. One record per account.
CREATE TABLE liabilities (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    account_id             uuid        NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT,

    liability_type         text,                       -- credit / mortgage / student
    last_payment_amount    numeric(20,4),
    last_payment_date      date,
    next_payment_due_date  date,
    minimum_payment_amount numeric(20,4),
    outstanding_balance    numeric(20,4),
    aprs                   jsonb,                       -- credit-card APR breakdown
    currency               text,

    raw                    jsonb,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX liabilities_user_id_idx ON liabilities (user_id);
CREATE TRIGGER liabilities_set_updated_at BEFORE UPDATE ON liabilities
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
