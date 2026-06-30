"use client";

// Tremor-style Button — primary / secondary / ghost, with a loading state.
import React from "react";
import { tv, type VariantProps } from "tailwind-variants";

import { cx, focusRing } from "../../lib/utils";

const buttonVariants = tv({
  base: [
    "relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-3 py-2 text-sm font-medium transition-colors",
    "disabled:pointer-events-none disabled:opacity-50",
    ...focusRing,
  ],
  variants: {
    variant: {
      primary:
        "border-transparent bg-blue-500 text-white hover:bg-blue-600 active:bg-blue-700",
      secondary:
        "border-gray-300 bg-white text-gray-900 hover:bg-gray-50",
      ghost:
        "border-transparent bg-transparent text-gray-600 hover:bg-gray-100 hover:text-gray-900",
    },
  },
  defaultVariants: { variant: "primary" },
});

interface ButtonProps
  extends React.ComponentPropsWithoutRef<"button">,
    VariantProps<typeof buttonVariants> {
  isLoading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, isLoading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      className={cx(buttonVariants({ variant }), className)}
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
