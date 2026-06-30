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

export function formatMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}
