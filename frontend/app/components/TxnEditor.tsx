"use client";

// Inline transaction editor — the ruling desk for one row. Edits map 1:1 to
// the override contract: only fields you actually changed are sent; clearing a
// field sends an explicit null (which removes that override and falls back to
// Plaid's value). Tag changes go to the separate tag-set endpoint.

import { useMemo, useState } from "react";

import {
  putOverride,
  setTransactionTags,
  type OverrideBody,
  type RulableTxnClass,
  type Tag,
  type Transaction,
} from "../lib/api";
import { RULABLE_CLASSES, TXN_CLASS } from "../lib/classes";
import { formatDate, formatSignedAmount } from "../lib/format";
import { cx, eyebrow, inputBase } from "../lib/utils";
import { Button } from "./ui/Button";
import { Select } from "./ui/Select";

const AUTO = "__auto__"; // select sentinel: no class override (rules/match decide)

export function TxnEditor({
  txn,
  allTags,
  categories,
  onSaved,
  onClose,
}: {
  txn: Transaction;
  allTags: Tag[];
  categories: string[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(txn.name ?? "");
  const [category, setCategory] = useState(txn.category ?? "");
  const [notes, setNotes] = useState(txn.notes ?? "");
  const [hidden, setHidden] = useState(txn.is_hidden);
  const [klass, setKlass] = useState<string>(
    txn.txn_class_source === "override" ? txn.txn_class : AUTO,
  );
  const [tagIds, setTagIds] = useState<string[]>(txn.tag_ids);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tagsChanged = useMemo(() => {
    const a = [...tagIds].sort().join(",");
    const b = [...txn.tag_ids].sort().join(",");
    return a !== b;
  }, [tagIds, txn.tag_ids]);

  async function save() {
    setSaving(true);
    setError(null);

    // Diff against the row's current effective values; only touched keys ship.
    const body: OverrideBody = {};
    if (name.trim() !== (txn.name ?? "")) body.name_override = name.trim() || null;
    if (category.trim() !== (txn.category ?? "")) body.category_override = category.trim() || null;
    if (notes.trim() !== (txn.notes ?? "")) body.notes = notes.trim() || null;
    if (hidden !== txn.is_hidden) body.is_hidden = hidden;
    const currentKlass = txn.txn_class_source === "override" ? txn.txn_class : AUTO;
    if (klass !== currentKlass) {
      body.txn_class_override = klass === AUTO ? null : (klass as RulableTxnClass);
    }

    try {
      if (Object.keys(body).length > 0) await putOverride(txn.id, body);
      if (tagsChanged) await setTransactionTags(txn.id, tagIds);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
      setSaving(false);
    }
  }

  function toggleTag(id: string) {
    setTagIds((ids) => (ids.includes(id) ? ids.filter((t) => t !== id) : [...ids, id]));
  }

  return (
    <div className="border-t border-dashed border-rule-strong bg-wash/50 px-4 py-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Edits */}
        <div className="space-y-3 lg:col-span-2">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={eyebrow}>Display name</span>
              <input
                className={cx(inputBase, "mt-1")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={txn.merchant_name ?? "transaction name"}
              />
            </label>
            <label className="block">
              <span className={eyebrow}>Category</span>
              <input
                className={cx(inputBase, "mt-1")}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                list="txn-categories"
                placeholder={txn.pfc_primary ?? "category"}
              />
              <datalist id="txn-categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <label className="block">
              <span className={eyebrow}>Class</span>
              <Select className="mt-1" value={klass} onChange={(e) => setKlass(e.target.value)}>
                <option value={AUTO}>
                  Auto — {TXN_CLASS[txn.txn_class].label}
                  {txn.txn_class_source === "match" ? " (paired)" : ""}
                </option>
                {RULABLE_CLASSES.map((c) => (
                  <option key={c} value={c}>
                    {TXN_CLASS[c].label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block">
              <span className={eyebrow}>Notes</span>
              <input
                className={cx(inputBase, "mt-1")}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="notes"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <label className="flex items-center gap-2 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={hidden}
                onChange={(e) => setHidden(e.target.checked)}
                className="size-3.5 rounded-none border-rule-strong text-ink focus:ring-ink/30"
              />
              Hide from summaries
            </label>
          </div>

          <div>
            <span className={eyebrow}>Tags</span>
            {allTags.length === 0 ? (
              <p className="mt-1 text-xs text-ink-3">
                No tags yet — create them on the Tags page.
              </p>
            ) : (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {allTags.map((t) => {
                  const on = tagIds.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => toggleTag(t.id)}
                      aria-pressed={on}
                      className={cx(
                        "rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tracking-wide transition-colors",
                        on
                          ? "border-ink bg-ink text-paper"
                          : "border-rule-strong bg-panel text-ink-2 hover:bg-wash",
                        "outline outline-offset-2 outline-0 focus-visible:outline-2 outline-ink",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className="mr-1 inline-block size-1.5 rounded-full align-middle"
                        style={{ backgroundColor: t.color || "#716d60" }}
                      />
                      {t.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Record — the row's facts, read-only */}
        <dl className="space-y-1.5 border-t border-rule pt-3 font-mono text-[11px] lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
          {[
            ["Amount", formatSignedAmount(txn.amount, txn.currency)],
            ["Date", formatDate(txn.date) + (txn.pending ? " · pending" : "")],
            ["Account", `${txn.account_name ?? "—"}${txn.account_mask ? ` ··${txn.account_mask}` : ""}`],
            ["Institution", txn.institution_name ?? "—"],
            ["Plaid category", txn.pfc_detailed ?? txn.pfc_primary ?? "—"],
            ["Confidence", txn.pfc_confidence ?? "—"],
            ["Channel", txn.payment_channel ?? "—"],
            [
              "Counterpart",
              txn.counterpart_account_name
                ? `${txn.counterpart_account_name}${txn.transfer_corroborated ? " · corroborated" : ""}`
                : "—",
            ],
            ["Class source", txn.txn_class_source],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="uppercase tracking-wide text-ink-3">{k}</dt>
              <dd className="text-right text-ink-2">{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      {error && <p className="mt-3 text-xs text-neg">{error}</p>}

      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" onClick={() => void save()} isLoading={saving}>
          Save changes
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <p className="ml-auto hidden text-[10px] text-ink-3 sm:block">
          Only changed fields are written; clearing a field restores Plaid&apos;s value.
        </p>
      </div>
    </div>
  );
}
