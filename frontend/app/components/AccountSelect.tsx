"use client";

// Account filter for the transactions table — a styled native select (Tremor's
// look without pulling in the Radix Select dependency).
import { RiArrowDownSLine } from "@remixicon/react";

import type { Account } from "../lib/api";
import { cx, focusInput } from "../lib/utils";

export function AccountSelect({
  accounts,
  value,
  onChange,
}: {
  accounts: Account[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative">
      <select
        aria-label="Filter by account"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx(
          "appearance-none rounded-md border border-gray-300 bg-white py-1.5 pl-3 pr-8 text-sm text-gray-900 shadow-sm",
          "focus:outline-none",
          ...focusInput,
        )}
      >
        <option value="">All accounts</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {(a.name ?? "Account") + (a.mask ? ` ··${a.mask}` : "")}
          </option>
        ))}
      </select>
      <RiArrowDownSLine className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-gray-400" />
    </div>
  );
}
