// Tremor-style Card — the surface every dashboard tile sits on.
import React from "react";

import { cx } from "../../lib/utils";

const Card = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cx(
      "rounded-lg border border-gray-200 bg-white p-6 shadow-sm",
      className,
    )}
    {...props}
  />
));
Card.displayName = "Card";

export { Card };
