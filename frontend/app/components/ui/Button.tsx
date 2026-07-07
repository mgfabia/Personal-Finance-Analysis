"use client";

// Ledger Button — primary (ink), secondary (paper + rule), ghost, danger.
import React from "react";
import { tv, type VariantProps } from "tailwind-variants";

import { cx, focusRing } from "../../lib/utils";

const buttonVariants = tv({
  base: [
    "relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border px-3 py-1.5 text-sm font-medium transition-colors",
    "disabled:pointer-events-none disabled:opacity-50",
    ...focusRing,
  ],
  variants: {
    variant: {
      primary: "border-transparent bg-ink text-paper hover:bg-ink/85 active:bg-ink",
      secondary: "border-rule-strong bg-panel text-ink hover:bg-wash",
      ghost: "border-transparent bg-transparent text-ink-2 hover:bg-wash hover:text-ink",
      danger: "border-neg/40 bg-panel text-neg hover:bg-neg/5",
    },
    size: {
      md: "",
      sm: "px-2 py-1 text-xs",
    },
  },
  defaultVariants: { variant: "primary", size: "md" },
});

interface ButtonProps
  extends React.ComponentPropsWithoutRef<"button">,
    VariantProps<typeof buttonVariants> {
  isLoading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, isLoading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      className={cx(buttonVariants({ variant, size }), className)}
      disabled={disabled || isLoading}
      {...props}
    >
      {isLoading && (
        <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  ),
);
Button.displayName = "Button";

export { Button };
