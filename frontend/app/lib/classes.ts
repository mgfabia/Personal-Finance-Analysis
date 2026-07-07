// The nine-class semantic color taxonomy — the ONLY place color carries meaning
// in The Ledger. Used identically by chips, filters, charts, and the review
// inbox so a class reads the same everywhere.
//
// Palette validated with the dataviz six-checks validator (light surface
// #faf9f6): all 9 pass lightness band, chroma floor, and >=3:1 contrast; worst
// adjacent CVD dE 19.7 in the canonical assignment order (target >=12). The
// stacked-chart trio (spending/debt/saving) passes independently (dE 43.7).
// Chips always pair color with a text label, so identity is never color-alone.
// `text` is a darker step of the same hue for >=4.5:1 small-text contrast.

import type { RulableTxnClass, TransferKind, TxnClass } from "./api";

export interface TxnClassSpec {
  label: string;
  color: string; // chart fill / dot
  text: string; // chip text (darker step, >=4.5:1)
  quarantine: boolean; // awaiting a user ruling
}

export const TXN_CLASS: Record<TxnClass, TxnClassSpec> = {
  spending: { label: "Spending", color: "#c2410c", text: "#9a3412", quarantine: false },
  income: { label: "Income", color: "#15803d", text: "#166534", quarantine: false },
  refund: { label: "Refund", color: "#0d9488", text: "#0f5e59", quarantine: false },
  internal_transfer: { label: "Transfer", color: "#0369a1", text: "#075985", quarantine: false },
  saving_investing: { label: "Saving", color: "#2563eb", text: "#1e40af", quarantine: false },
  debt_payment: { label: "Debt", color: "#be185d", text: "#9d174d", quarantine: false },
  cash: { label: "Cash", color: "#a16207", text: "#854d0e", quarantine: false },
  p2p_unclassified: { label: "P2P — unruled", color: "#7c3aed", text: "#6d28d9", quarantine: true },
  transfer_unmatched: { label: "Unmatched", color: "#d97706", text: "#92400e", quarantine: true },
};

/** Display order for filters and legends (semantic grouping; quarantine last). */
export const TXN_CLASS_ORDER: TxnClass[] = [
  "spending",
  "income",
  "refund",
  "cash",
  "saving_investing",
  "debt_payment",
  "internal_transfer",
  "p2p_unclassified",
  "transfer_unmatched",
];

/** The 7 classes a user may rule (quarantine classes are questions, not answers). */
export const RULABLE_CLASSES: RulableTxnClass[] = [
  "spending",
  "income",
  "refund",
  "internal_transfer",
  "saving_investing",
  "debt_payment",
  "cash",
];

/** Transfer kinds borrow their hue from the class they imply. */
export const TRANSFER_KIND: Record<TransferKind, { label: string; color: string; text: string }> = {
  card_payment: { label: "Card payment", color: TXN_CLASS.debt_payment.color, text: TXN_CLASS.debt_payment.text },
  to_investment: { label: "To investment", color: TXN_CLASS.saving_investing.color, text: TXN_CLASS.saving_investing.text },
  account_transfer: { label: "Account transfer", color: TXN_CLASS.internal_transfer.color, text: TXN_CLASS.internal_transfer.text },
};

/** `unallocated` in the income-allocation stack: deliberately recessive gray
 * (it means "nothing decided yet"); the ledger grid is its table-view relief. */
export const UNALLOCATED_COLOR = "#a8a29e";

/** Default palette offered when creating a tag (hex stored via the API). */
export const TAG_PALETTE = [
  "#2563eb",
  "#15803d",
  "#c2410c",
  "#7c3aed",
  "#0d9488",
  "#be185d",
  "#a16207",
  "#0369a1",
];
