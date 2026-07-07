-- 0005_account_display_name — user-editable account display names.
--
-- Same layering pattern as transaction_overrides: the Plaid-sourced value
-- (accounts.name, refreshed by reconcile_accounts on link/re-link) is never
-- touched; the user's name lives in its own nullable column that no sync path
-- writes. The read views resolve COALESCE(display_name, name), so every
-- consumer (transactions feed, transfers ledger, review queue, summaries)
-- picks the effective name up for free. NULL = "no custom name".
--
-- The two views are replaced with CREATE OR REPLACE (not DROP + CREATE, which
-- 0004 used): v_needs_review selects from v_transactions, so a DROP would
-- either fail on the dependency or CASCADE it away. OR REPLACE is legal here
-- because the output column list (names, types, order) is unchanged — only
-- what account_name / counterpart_account_name / from_account / to_account
-- compute changes.

ALTER TABLE accounts ADD COLUMN display_name text;

-- ---------------------------------------------------------------------------
-- v_transactions — verbatim from 0004 except the two COALESCE name lines.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_transactions AS
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
    COALESCE(a.display_name, a.name)               AS account_name,
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
    COALESCE(ca.display_name, ca.name)             AS counterpart_account_name,
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
-- v_transfers — verbatim from 0004 except the two COALESCE name lines.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_transfers AS
SELECT
    m.id,
    m.user_id,
    m.source,
    m.corroborated,
    o.date   AS out_date,
    i.date   AS in_date,
    o.amount AS amount,
    o.id     AS outflow_transaction_id,
    COALESCE(oa.display_name, oa.name)  AS from_account,
    i.id     AS inflow_transaction_id,
    COALESCE(ia.display_name, ia.name)  AS to_account,
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
