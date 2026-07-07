// Class helpers (Tremor-style cx) + The Ledger's shared interactive styles.
// cx merges conditional classes and de-dupes Tailwind conflicts.
import clsx, { type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cx(...args: ClassValue[]) {
  return twMerge(clsx(...args));
}

// Focus is ink, sharp and visible — a precision instrument, not a glow.
export const focusRing = [
  "outline outline-offset-2 outline-0 focus-visible:outline-2",
  "outline-ink",
];

export const focusInput = [
  "focus:outline-none focus:ring-2 focus:ring-ink/20 focus:border-ink",
];

export const hasErrorInput = [
  "ring-2 border-neg ring-neg/20",
];

// Shared field styles (native inputs/selects, ledger-flat).
export const inputBase = cx(
  "block w-full rounded-sm border border-rule-strong bg-panel px-2.5 py-1.5 text-sm text-ink",
  "placeholder:text-ink-3",
  ...focusInput,
);

// Mono uppercase eyebrow — column headers, nav, section labels.
export const eyebrow = "font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-ink-3";
