// API client — the browser's single channel to our backend.
//
// Security model (invariant 1): the browser talks only to our API and to Plaid
// Link. It never sees the Plaid secret or any access_token, and never calls a
// Plaid data endpoint. The session JWT (from /auth/login) is stored in
// localStorage and attached as `Authorization: Bearer` on every call — acceptable
// here because this is a private single-user app (see spec §Hand-rolled auth,
// Part 5). All money fields arrive as strings (Postgres numeric → JSON); Plaid
// sign convention throughout: amount > 0 = money OUT, amount < 0 = money IN.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const TOKEN_KEY = "pfa_token";

// --- token storage --------------------------------------------------------
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}

// Thrown on a 401 so callers (and the app-shell guard) can bounce to /login.
export class UnauthorizedError extends Error {}

// Thrown on any other non-2xx: `message` is the human-readable line (already
// extracted from the body), `detail` the raw parsed payload for callers that
// need structured fields (e.g. a 429's retry_after).
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly detail: unknown = null,
  ) {
    super(message);
  }
}

// --- core fetch -----------------------------------------------------------
async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");

  const res = await fetch(`${API_URL}${path}`, { ...init, headers });

  if (res.status === 401) {
    clearToken();
    throw new UnauthorizedError("session expired");
  }
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    let detail: unknown = null;
    try {
      const body = await res.json();
      if (body?.detail) {
        detail = body.detail;
        message =
          typeof body.detail === "string"
            ? body.detail
            : (body.detail.error_message ?? body.detail.message ?? JSON.stringify(body.detail));
      }
    } catch {
      /* non-JSON error body — keep the generic message */
    }
    throw new ApiError(message, res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// --- auth -----------------------------------------------------------------
export async function login(email: string, password: string): Promise<void> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    // Backend returns an identical 401 for unknown-email and wrong-password.
    throw new Error("Invalid email or password.");
  }
  const data = (await res.json()) as { access_token: string };
  setToken(data.access_token);
}

// --- semantic taxonomy (0004) ----------------------------------------------
export type TxnClass =
  | "spending"
  | "income"
  | "refund"
  | "internal_transfer"
  | "saving_investing"
  | "debt_payment"
  | "cash"
  | "p2p_unclassified"
  | "transfer_unmatched";

/** The 7 classes a user may rule; the two quarantine classes are never rulings. */
export type RulableTxnClass = Exclude<TxnClass, "p2p_unclassified" | "transfer_unmatched">;

export type TxnClassSource = "override" | "match" | "rule";
export type PfcConfidence = "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
export type ReviewReason = "p2p" | "unmatched_transfer" | "low_confidence";
export type TransferKind = "card_payment" | "to_investment" | "account_transfer";
export type TransferSource = "auto" | "user";

// --- types (mirror the read API / 0004 views) ------------------------------
export interface Transaction {
  id: string;
  account_id: string;
  account_name: string | null;
  account_mask: string | null;
  account_type: string | null;
  institution_name: string | null;
  date: string;
  datetime: string | null;
  amount: string; // numeric as string; > 0 = outflow, < 0 = inflow
  currency: string | null;
  name: string | null; // effective: name_override > merchant_name > raw name
  merchant_name: string | null;
  payment_channel: string | null;
  pending: boolean;
  pfc_primary: string | null;
  pfc_detailed: string | null;
  pfc_confidence: PfcConfidence | null;
  category: string | null; // effective: category_override > pfc_primary
  is_hidden: boolean;
  notes: string | null;
  tag_ids: string[];
  tags: string[];
  transfer_match_id: string | null;
  transfer_corroborated: boolean | null;
  counterpart_transaction_id: string | null;
  counterpart_account_name: string | null;
  txn_class: TxnClass;
  txn_class_source: TxnClassSource;
}

export interface MonthlySummary {
  month: string; // YYYY-MM-DD (first of month)
  currency: string | null;
  income: string;
  spending: string; // nets refunds, includes cash withdrawals
  debt_payments: string;
  saving_investing: string;
  p2p_out: string;
  p2p_in: string;
  unmatched_net: string;
  net: string; // income - spending - debt_payments
  unallocated: string; // net - saving_investing
  needs_review_count: number;
  txn_count: number;
}

export interface CategorySummary {
  month: string;
  category: string;
  currency: string | null;
  spending: string; // refunds net (negative rows offset)
  txn_count: number;
}

export interface Account {
  id: string;
  name: string | null;
  display_name: string | null;
  /** COALESCE(display_name, name) — the one server-computed fallback; use this for labels. */
  effective_name: string | null;
  official_name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  currency: string | null;
  current_balance: string | null;
  available_balance: string | null;
  institution_name: string | null;
}

export interface Transfer {
  id: string;
  source: TransferSource;
  corroborated: boolean;
  out_date: string;
  in_date: string;
  amount: string; // the outflow leg's amount (> 0)
  outflow_transaction_id: string;
  from_account: string | null;
  inflow_transaction_id: string;
  to_account: string | null;
  kind: TransferKind;
}

export interface ReviewItem {
  id: string;
  date: string;
  amount: string;
  name: string | null;
  account_name: string | null;
  txn_class: TxnClass;
  pfc_primary: string | null;
  pfc_detailed: string | null;
  pfc_confidence: PfcConfidence | null;
  reason: ReviewReason;
}

export interface SavingsRateMonth {
  month: string;
  currency: string | null;
  income: string;
  spending: string;
  debt_payments: string;
  saving_investing: string;
  net: string;
  savings_rate_explicit: string | null; // fraction 0–1 as string; null if income <= 0
  savings_rate_implied: string | null;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null; // hex
  txn_count: number;
}

// --- read endpoints ---------------------------------------------------------
export function getAccounts() {
  return apiFetch<{ accounts: Account[] }>("/api/accounts");
}

export interface TransactionFilters {
  limit?: number; // <= 500
  offset?: number;
  accountId?: string;
  startDate?: string; // YYYY-MM-DD
  endDate?: string;
  txnClass?: TxnClass;
  category?: string;
  pending?: boolean;
  tags?: string[]; // tag ids; OR semantics
}

export function getTransactions(params: TransactionFilters = {}) {
  const q = new URLSearchParams();
  if (params.limit != null) q.set("limit", String(params.limit));
  if (params.offset != null) q.set("offset", String(params.offset));
  if (params.accountId) q.set("account_id", params.accountId);
  if (params.startDate) q.set("start_date", params.startDate);
  if (params.endDate) q.set("end_date", params.endDate);
  if (params.txnClass) q.set("txn_class", params.txnClass);
  if (params.category) q.set("category", params.category);
  if (params.pending != null) q.set("pending", String(params.pending));
  for (const t of params.tags ?? []) q.append("tag", t);
  const qs = q.toString();
  return apiFetch<{ transactions: Transaction[]; limit: number; offset: number; count: number }>(
    `/api/transactions${qs ? `?${qs}` : ""}`,
  );
}

export function getMonthlySummary(params: { tags?: string[] } = {}) {
  const q = new URLSearchParams();
  for (const t of params.tags ?? []) q.append("tag", t);
  const qs = q.toString();
  return apiFetch<{ months: MonthlySummary[] }>(`/api/summary/monthly${qs ? `?${qs}` : ""}`);
}

export function getCategorySummary(params: { month?: string; tags?: string[] } = {}) {
  const q = new URLSearchParams();
  if (params.month) q.set("month", params.month);
  for (const t of params.tags ?? []) q.append("tag", t);
  const qs = q.toString();
  return apiFetch<{ categories: CategorySummary[] }>(`/api/summary/category${qs ? `?${qs}` : ""}`);
}

export function getTransfers() {
  return apiFetch<{ transfers: Transfer[] }>("/api/transfers");
}

export function getReview() {
  return apiFetch<{ review: ReviewItem[]; count: number }>("/api/review");
}

export function getSavingsRate() {
  return apiFetch<{ months: SavingsRateMonth[] }>("/api/savings-rate");
}

export function getTags() {
  return apiFetch<{ tags: Tag[] }>("/api/tags");
}

// --- write endpoints ---------------------------------------------------------
// Partial update: only keys PRESENT are written; an explicit null clears that
// override. Build the object with exactly the keys you mean to touch —
// undefined keys are dropped by JSON.stringify, which matches the contract.
export interface OverrideBody {
  category_override?: string | null;
  name_override?: string | null;
  notes?: string | null;
  is_hidden?: boolean;
  txn_class_override?: RulableTxnClass | null;
}

export function putOverride(txnId: string, body: OverrideBody) {
  return apiFetch<{ transaction_id: string; updated: string[] }>(
    `/api/transactions/${txnId}/override`,
    { method: "PUT", body: JSON.stringify(body) },
  );
}

export function setTransactionTags(txnId: string, tagIds: string[]) {
  return apiFetch<{ transaction_id: string; tag_ids: string[] }>(
    `/api/transactions/${txnId}/tags`,
    { method: "PUT", body: JSON.stringify({ tag_ids: tagIds }) },
  );
}

export function createTag(name: string, color?: string) {
  return apiFetch<{ id: string; name: string; color: string | null }>("/api/tags", {
    method: "POST",
    body: JSON.stringify({ name, color }),
  });
}

export function updateTag(tagId: string, patch: { name?: string; color?: string }) {
  return apiFetch<{ id: string; name: string; color: string | null }>(`/api/tags/${tagId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function updateAccount(accountId: string, patch: { display_name: string | null }) {
  return apiFetch<{ id: string; display_name: string | null; name: string | null }>(
    `/api/accounts/${accountId}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

export function deleteTag(tagId: string) {
  return apiFetch<{ deleted: string }>(`/api/tags/${tagId}`, { method: "DELETE" });
}

export function createTransfer(outflowTransactionId: string, inflowTransactionId: string) {
  return apiFetch<{ id: string; source: "user" }>("/api/transfers", {
    method: "POST",
    body: JSON.stringify({
      outflow_transaction_id: outflowTransactionId,
      inflow_transaction_id: inflowTransactionId,
    }),
  });
}

/** Unlink a pair. reject=true tombstones it so the matcher never re-proposes it. */
export function deleteTransfer(matchId: string, reject: boolean) {
  return apiFetch<{ deleted: string; rejected: boolean }>(
    `/api/transfers/${matchId}?reject=${reject}`,
    { method: "DELETE" },
  );
}

// --- Plaid Link flow (Phase 2 endpoints) ----------------------------------
// OAuth banks redirect the browser away mid-Link and back to /oauth, so the
// link_token must survive the round-trip. localStorage (not React state) per
// Plaid's OAuth guide — the return can even land in a fresh tab on mobile.
const LINK_TOKEN_KEY = "pfa_link_token";

export function storeLinkToken(token: string): void {
  window.localStorage.setItem(LINK_TOKEN_KEY, token);
}

export function getStoredLinkToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(LINK_TOKEN_KEY);
}

export function clearStoredLinkToken(): void {
  window.localStorage.removeItem(LINK_TOKEN_KEY);
}

export function createLinkToken() {
  return apiFetch<{ link_token: string; expiration: string }>("/link/token/create", {
    method: "POST",
  });
}

export function exchangePublicToken(publicToken: string) {
  return apiFetch<{ item_id: string; institution_name: string | null }>(
    "/item/public_token/exchange",
    { method: "POST", body: JSON.stringify({ public_token: publicToken }) },
  );
}

// --- sync freshness / on-demand refresh ------------------------------------
export interface SyncStatusItem {
  id: string;
  institution_name: string | null;
  status: "healthy" | "login_required" | "pending_expiration" | "revoked";
  last_synced_at: string | null;
  last_error: { error_code?: string | null; error_message?: string | null } | null;
}

export function getSyncStatus() {
  return apiFetch<{
    items: SyncStatusItem[];
    refresh_cooldown_remaining: number; // seconds; > 0 while the cooldown is live
    cooldown_seconds: number;
  }>("/api/sync-status");
}

/** Fire-and-forget: asks Plaid to re-poll each bank (billed per call); results
 * land later via webhook → sync. 429 (ApiError) carries detail.retry_after. */
export function refreshTransactions() {
  return apiFetch<{
    requested: number;
    failed: { institution_name: string; error_code: string }[];
    skipped: number;
    cooldown_seconds: number;
  }>("/api/transactions/refresh", { method: "POST" });
}
