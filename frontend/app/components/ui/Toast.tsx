"use client";

// Minimal transient status pill (no toast library) — paper/ink identity, mono.
// The live region stays mounted (and never display:none) so screen readers
// announce content *changes*; only the visible chrome toggles with the message.
import { cx } from "../../lib/utils";

export function Toast({ message, tone = "info" }: { message: string; tone?: "info" | "error" }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        "fixed bottom-4 right-4 z-50 font-mono text-xs",
        message && "rounded-sm border bg-panel px-3 py-2 shadow-sm",
        message && (tone === "error" ? "border-neg/40 text-neg" : "border-rule-strong text-ink"),
      )}
    >
      {message}
    </div>
  );
}
