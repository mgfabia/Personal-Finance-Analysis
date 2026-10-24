-- 0007_recurring_obligations — user-declared recurring obligations (rent, ...).
--
-- An obligation says "every month around day D, about $A goes out matching
-- these filters; N people pay me back ~$S each". The matcher (derive.py) groups
-- each month's payment and reimbursements into one event; the views then
-- classify the payment as spending and the reimbursements as refunds, both in
-- the obligation's category — so category totals show the user's net share.
--
-- Persistence criterion (design-notes/transaction-semantics/06): obligations
-- carry user intent → table. Their matches are not a pure function of a
-- single row (one event spans several rows) → table, but fully derived: wiped
-- and rebuilt on every derive run, so there is no source/rejection state.
--
-- Precedence in v_transactions: user override > obligation > transfer pair >
-- rules. The transfer matcher skips obligation-matched legs, so a row is never
-- both.

CREATE TABLE obligations (
    id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 uuid          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name                    text          NOT NULL CHECK (btrim(name) <> ''),
    -- Effective category for every matched row (payment and reimbursements).
    category                text          NOT NULL CHECK (btrim(category) <> ''),

    -- Filters. NULL = any account / any description. match_text is a
    -- case-insensitive substring of the row's name, merchant or counterparty.
    account_id              uuid          REFERENCES accounts(id) ON DELETE SET NULL,
    match_text              text,

    -- The payment: one outflow per month near day_of_month (clamped to the
    -- month's last day), |amount - expected| <= amount_tolerance.
    amount                  numeric(20,4) NOT NULL CHECK (amount > 0),
    amount_tolerance        numeric(20,4) NOT NULL DEFAULT 0 CHECK (amount_tolerance >= 0),
    day_of_month            smallint      NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
    -- ±days around the expected date, for the payment and reimbursements.
    -- Capped at 10 so a row can never be near two months' expected dates.
    day_window              smallint      NOT NULL DEFAULT 5 CHECK (day_window BETWEEN 0 AND 10),

    -- Reimbursements: up to reimbursement_count shares of ~reimbursement_amount
    -- per month. One inflow may cover several shares (a combined payment).
    reimbursement_amount    numeric(20,4) CHECK (reimbursement_amount > 0),
    reimbursement_count     smallint      NOT NULL DEFAULT 0
                                          CHECK (reimbursement_count BETWEEN 0 AND 20),
    reimbursement_tolerance numeric(20,4) NOT NULL DEFAULT 0
                                          CHECK (reimbursement_tolerance >= 0),

    -- Active months (inclusive; NULL = open-ended). A lease change = end this
    -- obligation and start a new one, so old months keep their old terms.
    start_month             date          CHECK (start_month = date_trunc('month', start_month)),
    end_month               date          CHECK (end_month = date_trunc('month', end_month)),

    active                  boolean       NOT NULL DEFAULT true,
    created_at              timestamptz   NOT NULL DEFAULT now(),
    updated_at              timestamptz   NOT NULL DEFAULT now(),

    CHECK ((reimbursement_count = 0) = (reimbursement_amount IS NULL)),
    CHECK (end_month IS NULL OR start_month IS NULL OR end_month >= start_month)
);
CREATE INDEX obligations_user_id_idx ON obligations (user_id);
CREATE TRIGGER obligations_set_updated_at BEFORE UPDATE ON obligations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE obligation_matches (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    obligation_id  uuid        NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
    -- A row belongs to at most one obligation event.
    transaction_id uuid        NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
    period         date        NOT NULL CHECK (period = date_trunc('month', period)),
    role           text        NOT NULL CHECK (role IN ('payment', 'reimbursement')),
    shares         smallint    NOT NULL DEFAULT 1 CHECK (shares >= 1),
    created_at     timestamptz NOT NULL DEFAULT now()
);
-- One payment per obligation per month.
CREATE UNIQUE INDEX obligation_matches_one_payment_idx
    ON obligation_matches (obligation_id, period) WHERE role = 'payment';
CREATE INDEX obligation_matches_user_id_idx ON obligation_matches (user_id);

-- ---------------------------------------------------------------------------
-- v_transactions — 0005's definition plus the obligation join: category and
-- class precedence step 2, and four appended columns (CREATE OR REPLACE may
-- only append, so the existing column list is unchanged).
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
    COALESCE(o.category_override, ob.category, t.pfc_primary) AS category,
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
        -- 2. recurring obligation: the payment is spending, reimbursements
        --    offset it (refunds net inside the obligation's category)
        WHEN om.role = 'payment'              THEN 'spending'
        WHEN om.role = 'reimbursement'        THEN 'refund'
        -- 3. paired legs; a pair touching an investment account IS the
        --    saving event (inert today; load-bearing when a CMA/brokerage
        --    cash account links)
        WHEN ct.id IS NOT NULL
             AND (a.type = 'investment' OR ca.type = 'investment')
                                              THEN 'saving_investing'
        WHEN ct.id IS NOT NULL                THEN 'internal_transfer'
        -- 4. payment apps are algorithmically unknowable
        WHEN t.raw -> 'counterparties' @> '[{"type":"payment_app"}]'
             OR t.pfc_detailed LIKE '%FROM\_APPS' ESCAPE '\'
                                              THEN 'p2p_unclassified'
        -- 5. one-leg-visible movement by detailed category
        WHEN t.pfc_detailed IN ('TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',
                                'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS')
                                              THEN 'saving_investing'
        WHEN t.pfc_detailed = 'TRANSFER_OUT_WITHDRAWAL'
                                              THEN 'cash'
        WHEN t.pfc_detailed = 'TRANSFER_OUT_CRYPTO'      -- PFCv2-only
                                              THEN 'saving_investing'
        -- 6. unpaired loan payments: payment to an unlinked card/loan
        WHEN t.pfc_primary = 'LOAN_PAYMENTS'  THEN 'debt_payment'
        -- 7. unpaired transfer-shaped rows: quarantine, don't guess.
        --    LOAN_DISBURSEMENTS (v2: borrowed money in — not income, not a
        --    refund) and OTHER (v2 wildcard) are routed here deliberately.
        WHEN t.pfc_primary IN ('TRANSFER_IN', 'TRANSFER_OUT',
                               'LOAN_DISBURSEMENTS', 'OTHER')
                                              THEN 'transfer_unmatched'
        -- 8. plain rows
        WHEN t.pfc_primary = 'INCOME' AND t.amount < 0
                                              THEN 'income'
        WHEN t.amount < 0                     THEN 'refund'
        ELSE 'spending'
    END                                            AS txn_class,
    CASE
        WHEN o.txn_class_override IS NOT NULL THEN 'override'
        WHEN om.id IS NOT NULL                THEN 'obligation'
        WHEN ct.id IS NOT NULL                THEN 'match'
        ELSE 'rule'
    END                                            AS txn_class_source,
    ob.id                                          AS obligation_id,
    ob.name                                        AS obligation_name,
    om.role                                        AS obligation_role,
    om.period                                      AS obligation_period
FROM transactions t
JOIN accounts a ON a.id = t.account_id
JOIN items    i ON i.id = a.current_item_id
LEFT JOIN transaction_overrides o ON o.transaction_id = t.id
LEFT JOIN obligation_matches om   ON om.transaction_id = t.id
LEFT JOIN obligations        ob   ON ob.id = om.obligation_id
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
-- Summary rollups — 0004's functions with one change: an obligation row counts
-- in its obligation month, not its calendar month. Rent paid Feb 27 for March
-- (and roommates paying back Mar 2) lands whole in March instead of swinging
-- February up and March negative. Every other row is unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_monthly_summary(p_user_id uuid DEFAULT NULL,
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
            COALESCE(v.obligation_period, date_trunc('month', v.date)::date) AS month,
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
        GROUP BY v.user_id, COALESCE(v.obligation_period, date_trunc('month', v.date)::date), v.currency
    ) s
$$;

CREATE OR REPLACE FUNCTION fn_category_summary(p_user_id uuid DEFAULT NULL,
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
        COALESCE(v.obligation_period, date_trunc('month', v.date)::date) AS month,
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
    GROUP BY v.user_id, COALESCE(v.obligation_period, date_trunc('month', v.date)::date), 3, v.currency
$$;
