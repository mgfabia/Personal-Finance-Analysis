// Display formatting. Money arrives as strings (Postgres numeric → JSON); parse
// only for presentation, never for arithmetic we persist.

export function formatMoney(value: string | number, currency: string | null = "USD"): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(n)) return String(value);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(n);
  } catch {
    // Unknown currency code — fall back to a plain 2-dp number.
    return n.toFixed(2);
  }
}

// A transaction amount is positive when money leaves the account (Plaid's sign
// convention). Show outflows plainly and inflows with a leading sign so a glance
// distinguishes them.
export function formatSignedAmount(amount: string, currency: string | null): string {
  const n = Number(amount);
  if (n < 0) return `+${formatMoney(-n, currency)}`; // inflow / income
  return formatMoney(n, currency); // outflow / spending
}

export function isInflow(amount: string): boolean {
  return Number(amount) < 0;
}

// Ledger-grid figure: plain 2-dp grouped number, negatives in accountant
// parentheses — "(1,234.56)". No currency symbol; the grid header carries it.
export function formatLedger(value: string | number): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(n)) return String(value);
  const abs = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(n));
  return n < 0 ? `(${abs})` : abs;
}

// Savings rates arrive as fraction strings 0–1 (nullable).
export function formatPercent(fraction: string | number | null): string {
  if (fraction === null || fraction === undefined) return "—";
  const n = typeof fraction === "string" ? Number(fraction) : fraction;
  if (Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

export function formatDate(date: string): string {
  // date is YYYY-MM-DD; render without timezone drift.
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateShort(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function formatMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

export function formatMonthShort(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
  });
}

// --- date arithmetic on YYYY-MM-DD strings (UTC-safe) ----------------------
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Whole-day difference b − a (both YYYY-MM-DD). */
export function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  if (!ay || !by) return 0;
  const ms = Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad);
  return Math.round(ms / 86_400_000);
}

/** Relative time for an ISO timestamp (server timestamptz) — "3 hours ago". */
export function formatTimeAgo(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const sec = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(sec);
  if (abs < 60) return "just now";
  if (abs < 3600) return rtf.format(Math.trunc(sec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.trunc(sec / 3600), "hour");
  return rtf.format(Math.trunc(sec / 86400), "day");
}

/** First day of the current month, YYYY-MM-DD (matches summary `month` keys). */
export function currentMonthKey(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${m}-01`;
}
