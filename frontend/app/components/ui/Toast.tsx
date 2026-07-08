"use client";

// Minimal transient status pill (no toast library) — paper/ink identity, mono.
import { cx } from "../../lib/utils";

export function Toast({ message, tone = "info" }: { message: string; tone?: "info" | "error" }) {
  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        "fixed bottom-4 right-4 z-50 rounded-sm border bg-panel px-3 py-2 font-mono text-xs shadow-sm",
        tone === "error" ? "border-neg/40 text-neg" : "border-rule-strong text-ink",
      )}
    >
      {message}
    </div>
  );
}
