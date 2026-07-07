-- 0004_semantic_views — the transaction-semantics read layer.
--
-- Rewrites the 0002 views around a derived txn_class and the 0003 pairing
-- tables. Everything here is computed-on-read (Principle 5); the only
-- persisted semantics state is what 0003 created.
--
-- The txn_class taxonomy (see design-notes/transaction-semantics/06):
--   spending            real purchases
--   income              payroll, interest, ...
--   refund              inflow inside a spend category — offsets spending,
--                       never income (kept negative so SUM() nets it)
--   internal_transfer   both legs visible & paired — excluded from cash flow
--   saving_investing    money to investment/retirement (one- or two-leg)
--   debt_payment        unpaired LOAN_PAYMENTS leg — payment to an UNLINKED
--                       card/loan; the only visible trace of that spending
--   cash                ATM withdrawals (synthetic category CASH_WITHDRAWAL)
--   p2p_unclassified    payment-app rows (Venmo) awaiting a user ruling
--   transfer_unmatched  transfer-shaped with no counterpart — quarantined
--
-- Precedence is the CASE order: user override > pairing > rules. Plaid sign
-- convention throughout: amount > 0 = money out, amount < 0 = money in.

DROP VIEW IF EXISTS v_category_summary;
DROP VIEW IF EXISTS v_monthly_summary;
DROP VIEW IF EXISTS v_transactions;

-- ---------------------------------------------------------------------------
-- v_transactions — the classified, override-applied, tag-enriched feed.
-- ---------------------------------------------------------------------------
CREATE VIEW v_transactions AS
WITH matched AS (
    -- Both directions of each pair, so any leg finds its counterpart.
    SELECT m.id  AS match_id, m.source AS match_source, m.corroborated,
           m.outflow_transaction_id AS txn_id,
           m.inflow_transaction_id  AS counterpart_id
    FROM transfer_matches m
    UNION ALL
    SELECT m.id, m.source, m.corroborated,
           m.inflow_transaction_id, m.outflow_transaction_id
    FROM transfer_matches m
)
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
    COALESCE(o.name_override, t.merchant_name, t.name) AS name,
    t.merchant_name,
    t.payment_channel,
    t.pending,
    t.pfc_primary,
    t.pfc_detailed,
    t.raw -> 'personal_finance_category' ->> 'confidence_level' AS pfc_confidence,
    COALESCE(o.category_override, t.pfc_primary)   AS category,
    COALESCE(o.is_hidden, false)                   AS is_hidden,
    o.notes,
    COALESCE(tgs.tag_ids, '{}')                    AS tag_ids,
    COALESCE(tgs.tags, '{}')                       AS tags,
    -- Pairing (ct join makes a match effective only while its other leg is
    -- live — a stale pair degrades gracefully instead of resurrecting money).
    CASE WHEN ct.id IS NOT NULL THEN m.match_id END      AS transfer_match_id,
    CASE WHEN ct.id IS NOT NULL THEN m.corroborated END  AS transfer_corroborated,
    ct.id                                          AS counterpart_transaction_id,
    ca.name                                        AS counterpart_account_name,
    -- The classification. Precedence = CASE order, first match wins.
    CASE
        -- 1. user always wins
        WHEN o.txn_class_override IS NOT NULL THEN o.txn_class_override
        -- 2. paired legs; a pair touching an investment account IS the
        --    saving event (inert today; load-bearing when a CMA/brokerage
        --    cash account links)
        WHEN ct.id IS NOT NULL
             AND (a.type = 'investment' OR ca.type = 'investment')
                                              THEN 'saving_investing'
        WHEN ct.id IS NOT NULL                THEN 'internal_transfer'
        -- 3. payment apps are algorithmically unknowable
        WHEN t.raw -> 'counterparties' @> '[{"type":"payment_app"}]'
             OR t.pfc_detailed LIKE '%FROM\_APPS' ESCAPE '\'
                                              THEN 'p2p_unclassified'
        -- 4. one-leg-visible movement by detailed category
        WHEN t.pfc_detailed IN ('TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',
                                'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS')
                                              THEN 'saving_investing'
        WHEN t.pfc_detailed = 'TRANSFER_OUT_WITHDRAWAL'
                                              THEN 'cash'
        WHEN t.pfc_detailed = 'TRANSFER_OUT_CRYPTO'      -- PFCv2-only
                                              THEN 'saving_investing'
        -- 5. unpaired loan payments: payment to an unlinked card/loan
        WHEN t.pfc_primary = 'LOAN_PAYMENTS'  THEN 'debt_payment'
        -- 6. unpaired transfer-shaped rows: quarantine, don't guess.
        --    LOAN_DISBURSEMENTS (v2: borrowed money in — not income, not a
        --    refund) and OTHER (v2 wildcard) are routed here deliberately.
        WHEN t.pfc_primary IN ('TRANSFER_IN', 'TRANSFER_OUT',
                               'LOAN_DISBURSEMENTS', 'OTHER')
                                              THEN 'transfer_unmatched'
        -- 7. plain rows
        WHEN t.pfc_primary = 'INCOME' AND t.amount < 0
                                              THEN 'income'
        WHEN t.amount < 0                     THEN 'refund'
        ELSE 'spending'
    END                                            AS txn_class,
    CASE
        WHEN o.txn_class_override IS NOT NULL THEN 'override'
        WHEN ct.id IS NOT NULL                THEN 'match'
        ELSE 'rule'
    END                                            AS txn_class_source
FROM transactions t
JOIN accounts a ON a.id = t.account_id
JOIN items    i ON i.id = a.current_item_id
LEFT JOIN transaction_overrides o ON o.transaction_id = t.id
LEFT JOIN matched m               ON m.txn_id = t.id
LEFT JOIN transactions ct         ON ct.id = m.counterpart_id
                                 AND ct.removed_at IS NULL
LEFT JOIN accounts     ca         ON ca.id = ct.account_id
LEFT JOIN LATERAL (
    SELECT array_agg(tt.tag_id)                    AS tag_ids,
           array_agg(tg.name::text ORDER BY tg.name) AS tags
    FROM transaction_tags tt
    JOIN tags tg ON tg.id = tt.tag_id
    WHERE tt.transaction_id = t.id
) tgs ON true
WHERE t.removed_at IS NULL
  -- pending-shadow guard: hide a pending row already superseded by a live
  -- posted row (normally Plaid removes the pending, but the window between
  -- the posted add and the pending remove must not double-show).
  AND NOT (t.pending AND EXISTS (
        SELECT 1 FROM transactions p
        WHERE p.pending_transaction_id = t.plaid_transaction_id
          AND p.removed_at IS NULL));

-- ---------------------------------------------------------------------------
-- Summary rollups as set-returning functions — one canonical definition each,
-- callable unfiltered (the wrapper views) or filtered by user/tags (the API).
-- p_tag_ids uses ANY-of (array overlap) semantics.
-- ---------------------------------------------------------------------------
CREATE FUNCTION fn_monthly_summary(p_user_id uuid DEFAULT NULL,
                                   p_tag_ids uuid[] DEFAULT NULL)
RETURNS TABLE (
    user_id            uuid,
    month              date,
    currency           text,
    income             numeric,
    spending           numeric,
    debt_payments      numeric,
    saving_investing   numeric,
    p2p_out            numeric,
    p2p_in             numeric,
    unmatched_net      numeric,
    net                numeric,
    unallocated        numeric,
    needs_review_count bigint,
    txn_count          bigint
)
LANGUAGE sql STABLE AS $$
    SELECT s.user_id, s.month, s.currency,
           s.income, s.spending, s.debt_payments, s.saving_investing,
           s.p2p_out, s.p2p_in, s.unmatched_net,
           s.income - s.spending - s.debt_payments                      AS net,
           s.income - s.spending - s.debt_payments - s.saving_investing AS unallocated,
           s.needs_review_count,
           s.txn_count
    FROM (
        SELECT
            v.user_id,
            date_trunc('month', v.date)::date AS month,
            v.currency,
            COALESCE(SUM(-v.amount) FILTER (WHERE v.txn_class = 'income'), 0)   AS income,
            -- refunds are negative rows inside 'spending': they net here
            COALESCE(SUM(v.amount) FILTER (
                WHERE v.txn_class IN ('spending', 'refund', 'cash')), 0)        AS spending,
            -- self-nets: an unpaired inflow leg on a card offsets the outflow
            COALESCE(SUM(v.amount) FILTER (WHERE v.txn_class = 'debt_payment'), 0)
                                                                                AS debt_payments,
            COALESCE(SUM(v.amount) FILTER (WHERE v.txn_class = 'saving_investing'), 0)
                                                                                AS saving_investing,
            COALESCE(SUM(v.amount) FILTER (
                WHERE v.txn_class = 'p2p_unclassified' AND v.amount > 0), 0)    AS p2p_out,
            COALESCE(SUM(-v.amount) FILTER (
                WHERE v.txn_class = 'p2p_unclassified' AND v.amount < 0), 0)    AS p2p_in,
            COALESCE(SUM(v.amount) FILTER (WHERE v.txn_class = 'transfer_unmatched'), 0)
                                                                                AS unmatched_net,
            COUNT(*) FILTER (WHERE v.txn_class IN ('p2p_unclassified',
                                                   'transfer_unmatched'))       AS needs_review_count,
            COUNT(*)                                                            AS txn_count
        FROM v_transactions v
        WHERE NOT v.is_hidden
          AND (p_user_id IS NULL OR v.user_id = p_user_id)
          AND (p_tag_ids IS NULL OR v.tag_ids && p_tag_ids)
        GROUP BY v.user_id, date_trunc('month', v.date)::date, v.currency
    ) s
$$;

CREATE FUNCTION fn_category_summary(p_user_id uuid DEFAULT NULL,
                                    p_tag_ids uuid[] DEFAULT NULL)
RETURNS TABLE (
    user_id   uuid,
    month     date,
    category  text,
    currency  text,
    spending  numeric,
    txn_count bigint
)
LANGUAGE sql STABLE AS $$
    SELECT
        v.user_id,
        date_trunc('month', v.date)::date AS month,
        CASE WHEN v.txn_class = 'cash' THEN 'CASH_WITHDRAWAL'
             ELSE COALESCE(v.category, 'UNCATEGORIZED') END AS category,
        v.currency,
        SUM(v.amount)  AS spending,      -- refunds are negative: they net here
        COUNT(*)       AS txn_count
    FROM v_transactions v
    WHERE NOT v.is_hidden
      AND v.txn_class IN ('spending', 'refund', 'cash')
      AND (p_user_id IS NULL OR v.user_id = p_user_id)
      AND (p_tag_ids IS NULL OR v.tag_ids && p_tag_ids)
    GROUP BY v.user_id, date_trunc('month', v.date)::date, 3, v.currency
$$;

-- Thin unfiltered wrappers: the pre-0004 names/contract keep working, and the
-- rollup logic lives in exactly one place (the functions above).
CREATE VIEW v_monthly_summary AS
    SELECT * FROM fn_monthly_summary();

CREATE VIEW v_category_summary AS
    SELECT * FROM fn_category_summary();

-- ---------------------------------------------------------------------------
-- v_transfers — the pair ledger: one row per matched transfer, both legs.
-- ---------------------------------------------------------------------------
CREATE VIEW v_transfers AS
SELECT
    m.id,
    m.user_id,
    m.source,
    m.corroborated,
    o.date   AS out_date,
    i.date   AS in_date,
    o.amount AS amount,
    o.id     AS outflow_transaction_id,
    oa.name  AS from_account,
    i.id     AS inflow_transaction_id,
    ia.name  AS to_account,
    CASE WHEN o.pfc_primary = 'LOAN_PAYMENTS' OR ia.type = 'credit'
             THEN 'card_payment'
         WHEN ia.type = 'investment'
             THEN 'to_investment'
         ELSE 'account_transfer'
    END AS kind
FROM transfer_matches m
JOIN transactions o ON o.id = m.outflow_transaction_id
JOIN transactions i ON i.id = m.inflow_transaction_id
JOIN accounts oa ON oa.id = o.account_id
JOIN accounts ia ON ia.id = i.account_id
WHERE o.removed_at IS NULL AND i.removed_at IS NULL;

-- ---------------------------------------------------------------------------
-- v_savings_rate — pure arithmetic over the monthly rollup.
-- explicit = flows deliberately sent to savings/investments; implied = income
-- simply not spent.
-- ---------------------------------------------------------------------------
CREATE VIEW v_savings_rate AS
SELECT user_id, month, currency, income, spending, debt_payments,
       saving_investing, net,
       CASE WHEN income > 0 THEN round(saving_investing / income, 4) END
           AS savings_rate_explicit,
       CASE WHEN income > 0 THEN round(net / income, 4) END
           AS savings_rate_implied
FROM v_monthly_summary;

-- ---------------------------------------------------------------------------
-- v_needs_review — the review inbox: everything awaiting a human ruling.
-- A category_override or txn_class_override clears a row permanently (the
-- category comparison detects an effective override without exposing the
-- overrides table).
-- ---------------------------------------------------------------------------
CREATE VIEW v_needs_review AS
SELECT id, user_id, date, amount, name, account_name, txn_class,
       pfc_primary, pfc_detailed, pfc_confidence,
       CASE WHEN txn_class = 'p2p_unclassified'   THEN 'p2p'
            WHEN txn_class = 'transfer_unmatched' THEN 'unmatched_transfer'
            ELSE 'low_confidence'
       END AS reason
FROM v_transactions
WHERE NOT is_hidden
  AND txn_class_source <> 'override'
  AND (txn_class IN ('p2p_unclassified', 'transfer_unmatched')
       OR (pfc_confidence IN ('LOW', 'UNKNOWN')
           AND category IS NOT DISTINCT FROM pfc_primary));
