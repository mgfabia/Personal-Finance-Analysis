// API client — Phase 8. The browser's single channel to our backend.
//
// Security model (invariant 1): the browser talks only to our API and to Plaid
// Link. It never sees the Plaid secret or any access_token, and never calls a
// Plaid data endpoint. The session JWT (from /auth/login) is stored in
// localStorage and attached as `Authorization: Bearer` on every call — acceptable
// here because this is a private single-user app (see spec §Hand-rolled auth,
// Part 5). All money fields arrive as strings (Postgres numeric → JSON).

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

// Thrown on a 401 so callers (and the dashboard guard) can bounce to /login.
export class UnauthorizedError extends Error {}

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
    let detail = `request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* non-JSON error body — keep the generic message */
    }
    throw new Error(detail);
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

// --- types (mirror the 7a read API / views) -------------------------------
export interface Transaction {
  id: string;
  account_name: string | null;
  account_mask: string | null;
  account_type: string | null;
  institution_name: string | null;
  date: string;
  datetime: string | null;
  amount: string; // numeric as string; positive = outflow, negative = inflow
  currency: string | null;
  name: string | null;
  merchant_name: string | null;
  payment_channel: string | null;
  pending: boolean;
  category: string | null;
  is_hidden: boolean;
  notes: string | null;
  tags: string[];
}

export interface MonthlySummary {
  month: string;
  currency: string | null;
  income: string;
  spending: string;
  net: string;
  txn_count: number;
}

export interface Account {
  id: string;
  name: string | null;
  official_name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  currency: string | null;
  current_balance: string | null;
  available_balance: string | null;
  institution_name: string | null;
}

// --- read endpoints -------------------------------------------------------
export function getAccounts() {
  return apiFetch<{ accounts: Account[] }>("/api/accounts");
}

export function getTransactions(params: { limit?: number; offset?: number; accountId?: string } = {}) {
  const q = new URLSearchParams();
  if (params.limit != null) q.set("limit", String(params.limit));
  if (params.offset != null) q.set("offset", String(params.offset));
  if (params.accountId) q.set("account_id", params.accountId);
  const qs = q.toString();
  return apiFetch<{ transactions: Transaction[]; limit: number; offset: number; count: number }>(
    `/api/transactions${qs ? `?${qs}` : ""}`,
  );
}

export function getMonthlySummary() {
  return apiFetch<{ months: MonthlySummary[] }>("/api/summary/monthly");
}

export interface CategorySummary {
  month: string;
  category: string;
  currency: string | null;
  spending: string;
  txn_count: number;
}

export function getCategorySummary(params: { month?: string } = {}) {
  const qs = params.month ? `?month=${encodeURIComponent(params.month)}` : "";
  return apiFetch<{ categories: CategorySummary[] }>(`/api/summary/category${qs}`);
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
