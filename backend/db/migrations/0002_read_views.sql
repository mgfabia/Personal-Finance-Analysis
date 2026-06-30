-- 0002_read_views — Phase 7a (transaction read API)
--
-- Business logic as plain SQL views (Principle 5: computed-on-read; promote to
-- materialized only if one ever gets slow). These are the contract the read
-- endpoints serve from — endpoints never touch raw tables.
--
-- Conventions baked in here:
--   * §2 tombstones: every view filters `transactions.removed_at IS NULL` so the
--     `removed` set never appears in results.
--   * Overrides survive re-syncs: `transaction_overrides` is LEFT JOIN'd and its
--     fields take precedence (name_override, category_override, is_hidden, …).
--   * Plaid sign convention: `amount > 0` is money OUT (spending), `amount < 0`
--     is money IN (income). Summaries normalize to positive income/spending.
--   * Identity/provenance (§3): account name is the identity; institution_name is
--     read through the account's current_item_id (provenance), never stored on
--     the transaction.
--
-- Net worth (balances + holdings − liabilities) is intentionally NOT here — it
-- needs Phase 5's products. It lands in a later migration (Phase 7b).

-- ---------------------------------------------------------------------------
-- v_transactions — the classified, override-applied transaction feed.
-- One row per live (non-removed) transaction, enriched with account/institution
-- and the user's manual edits. The read API's /api/transactions serves this.
-- ---------------------------------------------------------------------------
CREATE VIEW v_transactions AS
SELECT
    t.id,
    t.user_id,
    t.account_id,
    a.name                                         AS account_name,
    a.mask                                         AS account_mask,
    a.type                                         AS account_type,
    i.institution_name,
    t.date,
    t.datetime,
    t.amount,
    t.currency,
    -- Effective display fields: user override wins, else the Plaid value.
    COALESCE(o.name_override, t.merchant_name, t.name) AS name,
    t.merchant_name,
    t.payment_channel,
    t.pending,
    t.pfc_primary,
    t.pfc_detailed,
    -- Effective category: a manual category_override wins over Plaid's PFC.
    COALESCE(o.category_override, t.pfc_primary)   AS category,
    COALESCE(o.is_hidden, false)                   AS is_hidden,
    o.notes,
    COALESCE(o.tags, '{}')                         AS tags
FROM transactions t
JOIN accounts a ON a.id = t.account_id
JOIN items    i ON i.id = a.current_item_id
LEFT JOIN transaction_overrides o ON o.transaction_id = t.id
WHERE t.removed_at IS NULL;

-- ---------------------------------------------------------------------------
-- v_monthly_summary — income / spending / net per calendar month.
-- Built on v_transactions so it inherits the tombstone filter and the override
-- semantics; hidden transactions are excluded from totals.
-- ---------------------------------------------------------------------------
CREATE VIEW v_monthly_summary AS
SELECT
    user_id,
    date_trunc('month', date)::date                       AS month,
    currency,
    COALESCE(SUM(-amount) FILTER (WHERE amount < 0), 0)    AS income,
    COALESCE(SUM(amount)  FILTER (WHERE amount > 0), 0)    AS spending,
    COALESCE(SUM(-amount), 0)                              AS net,   -- income − spending
    COUNT(*)                                               AS txn_count
FROM v_transactions
WHERE NOT is_hidden
GROUP BY user_id, date_trunc('month', date)::date, currency;

-- ---------------------------------------------------------------------------
-- v_category_summary — outflow (spending) by effective category, per month.
-- Income rows (amount < 0) are excluded; this view answers "where did money go".
-- ---------------------------------------------------------------------------
CREATE VIEW v_category_summary AS
SELECT
    user_id,
    date_trunc('month', date)::date                AS month,
    COALESCE(category, 'UNCATEGORIZED')            AS category,
    currency,
    SUM(amount)                                    AS spending,
    COUNT(*)                                        AS txn_count
FROM v_transactions
WHERE NOT is_hidden
  AND amount > 0
GROUP BY user_id, date_trunc('month', date)::date, COALESCE(category, 'UNCATEGORIZED'), currency;
