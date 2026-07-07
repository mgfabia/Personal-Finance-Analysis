"use client";

// Styled native select (ledger-flat, no Radix dependency).
import { RiArrowDownSLine } from "@remixicon/react";
import React from "react";

import { cx, focusInput } from "../../lib/utils";

const Select = React.forwardRef<
  HTMLSelectElement,
  React.ComponentPropsWithoutRef<"select">
>(({ className, children, ...props }, ref) => (
  <div className={cx("relative", className)}>
    <select
      ref={ref}
      className={cx(
        "w-full appearance-none rounded-sm border border-rule-strong bg-panel py-1.5 pl-2.5 pr-8 text-sm text-ink",
        ...focusInput,
      )}
      {...props}
    >
      {children}
    </select>
    <RiArrowDownSLine className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
  </div>
));
Select.displayName = "Select";

export { Select };
