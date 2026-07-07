// The txn_class chip — the one place The Ledger spends color. Same treatment
// everywhere (tables, filters, review, transfers): tinted fill, hairline border
// in the class hue, dark-step text. Quarantine classes get a DASHED border —
// "awaiting a ruling" is visible beyond color. Identity is never color-alone:
// the label is always present.
import { TXN_CLASS } from "../../lib/classes";
import type { TxnClass, TxnClassSource } from "../../lib/api";
import { cx } from "../../lib/utils";

// txn_class_source, shown subtly after the label: user override (✱) and
// pair-derived (⇄) matter during an audit; plain rule needs no mark.
const SOURCE_MARK: Record<TxnClassSource, string | null> = {
  override: "✱",
  match: "⇄",
  rule: null,
};

const SOURCE_TITLE: Record<TxnClassSource, string> = {
  override: "class set by you",
  match: "class from a matched transfer pair",
  rule: "class from rules",
};

export function ClassChip({
  txnClass,
  source,
  className,
}: {
  txnClass: TxnClass;
  source?: TxnClassSource;
  className?: string;
}) {
  const spec = TXN_CLASS[txnClass];
  const mark = source ? SOURCE_MARK[source] : null;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 py-px",
        "font-mono text-[10px] font-medium uppercase tracking-wide",
        spec.quarantine && "border-dashed",
        className,
      )}
      style={{
        color: spec.text,
        borderColor: `${spec.color}59`, // 35% alpha
        backgroundColor: `${spec.color}12`, // 7% alpha
      }}
      title={source ? `${spec.label} — ${SOURCE_TITLE[source]}` : spec.label}
    >
      {spec.label}
      {mark && <span aria-hidden="true">{mark}</span>}
    </span>
  );
}
