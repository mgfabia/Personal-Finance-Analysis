// Tag chip — a colored dot + name. Tag colors come from the API's hex `color`
// (user-chosen); the dot carries the color so the text stays readable ink.
import { cx } from "../../lib/utils";

const FALLBACK = "#716d60"; // ink-3 — tags created without a color

export function TagChip({
  name,
  color,
  className,
}: {
  name: string;
  color?: string | null;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-rule bg-panel px-1.5 py-px",
        "font-mono text-[10px] font-medium tracking-wide text-ink-2",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color || FALLBACK }}
      />
      {name}
    </span>
  );
}
