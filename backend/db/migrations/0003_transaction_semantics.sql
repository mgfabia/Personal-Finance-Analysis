-- 0003_transaction_semantics — the semantics layer's persisted state.
--
-- Persistence criterion (design-notes/transaction-semantics/06): persist
-- derived data only when it is (a) not a pure function of a single row, or
-- (b) carries user intent. Transfer pairing passes both → two tables here.
-- Classification (txn_class) fails both → stays computed in the 0004 views.
--
-- Invariants:
--   * One-to-one pairing is enforced by the DATABASE: the per-leg UNIQUE
--     constraints on transfer_matches make double-matching impossible no
--     matter what the matcher does.
--   * User judgment is durable: source='user' matches and rejection rows
--     survive every idempotent rebuild (only source='auto' rows are wiped).
--   * Everything user-authored keys to the stable internal transactions.id
--     (same discipline as transaction_overrides), so it survives re-syncs.

-- ---------------------------------------------------------------------------
-- transfer_matches — active pairs. One row = "these two rows are the same
-- money" (checking→savings, checking→credit-card payment, ...).
-- ---------------------------------------------------------------------------
CREATE TABLE transfer_matches (
    id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    outflow_transaction_id  uuid        NOT NULL UNIQUE
                                        REFERENCES transactions(id) ON DELETE CASCADE,
    inflow_transaction_id   uuid        NOT NULL UNIQUE
                                        REFERENCES transactions(id) ON DELETE CASCADE,
    source                  text        NOT NULL DEFAULT 'auto'
                                        CHECK (source IN ('auto', 'user')),
    -- description-mask cross-check passed (e.g. the checking leg's name
    -- contains the savings account's last-4) — a confidence signal, never a
    -- match key.
    corroborated            boolean     NOT NULL DEFAULT false,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CHECK (outflow_transaction_id <> inflow_transaction_id)
);
CREATE INDEX transfer_matches_user_id_idx ON transfer_matches (user_id);
CREATE TRIGGER transfer_matches_set_updated_at BEFORE UPDATE ON transfer_matches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- transfer_match_rejections — "no transfer exists between THESE TWO."
-- Pair-scoped user judgment, permanent: rejecting (A,B) must not block (A,C),
-- and a rejection must survive every rebuild (else the matcher re-proposes
-- it nightly). Canonical ordering txn_a < txn_b makes the pair unique.
-- ---------------------------------------------------------------------------
CREATE TABLE transfer_match_rejections (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    txn_a      uuid        NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    txn_b      uuid        NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (txn_a < txn_b),
    UNIQUE (txn_a, txn_b)
);
CREATE INDEX transfer_match_rejections_user_idx ON transfer_match_rejections (user_id);

-- ---------------------------------------------------------------------------
-- txn_class_override — the user's ruling on a single row's class. Beats the
-- matcher and every rule (precedence 1 in the 0004 CASE). 'p2p_unclassified'
-- and 'transfer_unmatched' are deliberately not allowed: those classes mean
-- "no decision yet", and an override IS the decision.
-- ---------------------------------------------------------------------------
ALTER TABLE transaction_overrides
    ADD COLUMN txn_class_override text
        CHECK (txn_class_override IN (
            'spending', 'income', 'refund', 'internal_transfer',
            'saving_investing', 'debt_payment', 'cash'));

-- ---------------------------------------------------------------------------
-- tags — first-class user-created tags (registry + many-to-many join).
-- Replaces the never-written transaction_overrides.tags text[]: a registry
-- gives rename-cascade (one UPDATE), case-insensitive dedup (citext), and a
-- pickable list. Tags are annotation, orthogonal to category and class.
-- ---------------------------------------------------------------------------
CREATE TABLE tags (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name       citext      NOT NULL,
    color      text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);
CREATE TRIGGER tags_set_updated_at BEFORE UPDATE ON tags
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE transaction_tags (
    transaction_id uuid        NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    tag_id         uuid        NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (transaction_id, tag_id)
);
CREATE INDEX transaction_tags_tag_idx ON transaction_tags (tag_id);

-- The 0002 views read the old tags column; drop them before dropping it.
-- 0004 (same deploy) recreates all three around the semantics layer.
DROP VIEW IF EXISTS v_category_summary;
DROP VIEW IF EXISTS v_monthly_summary;
DROP VIEW IF EXISTS v_transactions;

ALTER TABLE transaction_overrides DROP COLUMN tags;
