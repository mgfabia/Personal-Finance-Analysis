// Ledger panel — flat white paper with a hairline rule, no shadow.
import React from "react";

import { cx } from "../../lib/utils";

const Card = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cx("rounded-sm border border-rule bg-panel p-5", className)}
    {...props}
  />
));
Card.displayName = "Card";

export { Card };
