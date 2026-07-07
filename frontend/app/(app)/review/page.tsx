"use client";

// Review — email-style triage over v_needs_review. Biggest amounts first (the
// API's order): resolve the material ones first. Each row expands to
// reason-specific quick actions:
//   p2p                → one-click class rulings (what was this Venmo, really?)
//   unmatched_transfer → counterpart-candidate picker (opposite amount, other
//                        account, ±4 days) or a class ruling
//   low_confidence     → confirm Plaid's category (writing even the same value
//                        clears the row) or fix it
// Rulings are optimistic: the row leaves the inbox immediately and returns
// with an error note if the write fails.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { useShell } from "../../components/AppShell";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Select } from "../../components/ui/Select";
import {
  createTransfer,
  getReview,
  getTransactions,
  putOverride,
  UnauthorizedError,
  type ReviewItem,
  type RulableTxnClass,
  type Transaction,
} from "../../lib/api";
import { RULABLE_CLASSES, TXN_CLASS } from "../../lib/classes";
import { addDays, dayDiff, formatDateShort, formatSignedAmount, isInflow } from "../../lib/format";
import { cx, eyebrow, inputBase } from "../../lib/utils";

const REASON = {
  p2p: { label: "P2P", color: TXN_CLASS.p2p_unclassified.color, text: TXN_CLASS.p2p_unclassified.text },
  unmatched_transfer: {
    label: "Unmatched",
    color: TXN_CLASS.transfer_unmatched.color,
    text: TXN_CLASS.transfer_unmatched.text,
  },
  low_confidence: { label: "Low confidence", color: "#716d60", text: "#57534a" },
} as const;

const P2P_QUICK: RulableTxnClass[] = ["spending", "income", "internal_transfer"];
const UNMATCHED_QUICK: RulableTxnClass[] = ["debt_payment", "income", "spending"];

interface Candidate {
  txn: Transaction;
  delta: number; // days from the review row's date
}

function ReasonBadge({ reason }: { reason: ReviewItem["reason"] }) {
  const spec = REASON[reason];
  return (
    <span
      className="inline-flex whitespace-nowrap rounded-sm border border-dashed px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wide"
      style={{ color: spec.text, borderColor: `${spec.color}80`, backgroundColor: `${spec.color}12` }}
    >
      {spec.label}
    </span>
  );
}

export default function ReviewPage() {
  const router = useRouter();
  const { refreshReview } = useShell();

  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // Counterpart candidates, fetched lazily per expanded unmatched row.
  const [candidates, setCandidates] = useState<Record<string, Candidate[] | "loading" | "error">>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getReview();
      setItems(res.review);
    } catch (e) {
      if (e instanceof UnauthorizedError) return router.replace("/login");
      setError(e instanceof Error ? e.message : "Failed to load the review queue.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  // --- optimistic resolution ------------------------------------------------
  async function resolve(item: ReviewItem, action: () => Promise<unknown>) {
    setItems((xs) => xs.filter((x) => x.id !== item.id));
    setOpenId(null);
    setError(null);
    try {
      await action();
      refreshReview();
    } catch (e) {
      if (e instanceof UnauthorizedError) return router.replace("/login");
      // Put the row back where it was (list is amount-ordered; re-sort).
      setItems((xs) =>
        [...xs, item].sort((a, b) => Math.abs(Number(b.amount)) - Math.abs(Number(a.amount))),
      );
      setError(e instanceof Error ? e.message : "Could not save the ruling.");
    }
  }

  function ruleClass(item: ReviewItem, cls: RulableTxnClass) {
    void resolve(item, () => putOverride(item.id, { txn_class_override: cls }));
  }

  function ruleCategory(item: ReviewItem, category: string) {
    void resolve(item, () => putOverride(item.id, { category_override: category }));
  }

  function pair(item: ReviewItem, candidate: Transaction) {
    const itemIsOutflow = Number(item.amount) > 0;
    const outId = itemIsOutflow ? item.id : candidate.id;
    const inId = itemIsOutflow ? candidate.id : item.id;
    void resolve(item, () => createTransfer(outId, inId));
  }

  // --- counterpart candidates -------------------------------------------------
  const loadCandidates = useCallback(async (item: ReviewItem) => {
    setCandidates((c) => ({ ...c, [item.id]: "loading" }));
    try {
      const res = await getTransactions({
        startDate: addDays(item.date, -4),
        endDate: addDays(item.date, 4),
        limit: 500,
      });
      const self = res.transactions.find((t) => t.id === item.id);
      const wanted = -Number(item.amount);
      const found = res.transactions
        .filter(
          (t) =>
            t.id !== item.id &&
            Number(t.amount) === wanted &&
            (!self || t.account_id !== self.account_id) &&
            !t.transfer_match_id,
        )
        .map((t) => ({ txn: t, delta: dayDiff(item.date, t.date) }))
        .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
      setCandidates((c) => ({ ...c, [item.id]: found }));
    } catch {
      setCandidates((c) => ({ ...c, [item.id]: "error" }));
    }
  }, []);

  function toggle(item: ReviewItem) {
    const next = openId === item.id ? null : item.id;
    setOpenId(next);
    if (next && item.reason === "unmatched_transfer" && candidates[item.id] === undefined) {
      void loadCandidates(item);
    }
  }

  // --- render -------------------------------------------------------------
  if (loading) {
    return (
      <p className="py-24 text-center font-mono text-xs uppercase tracking-widest text-ink-3">
        Loading the inbox…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="font-mono text-base font-semibold uppercase tracking-[0.14em] text-ink">
          Review
        </h1>
        {items.length > 0 && (
          <p className={eyebrow}>
            {items.length} awaiting your ruling · largest first
          </p>
        )}
      </div>

      {error && <p className="text-sm text-neg">{error}</p>}

      {items.length === 0 ? (
        /* Inbox zero — the payoff moment. */
        <Card className="py-16 text-center">
          <p className="font-mono text-2xl font-semibold uppercase tracking-[0.3em] text-ink">
            Inbox zero
          </p>
          <div className="mx-auto mt-4 h-px w-24 bg-rule-strong" />
          <p className="mt-4 text-sm text-ink-2">
            Every transaction has a ruling. The ledger is clean.
          </p>
        </Card>
      ) : (
        <Card className="p-0">
          {items.map((item) => {
            const open = openId === item.id;
            const cand = candidates[item.id];
            return (
              <div key={item.id} className="border-b border-rule last:border-0">
                <button
                  onClick={() => toggle(item)}
                  aria-expanded={open}
                  className={cx(
                    "grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2 text-left sm:grid-cols-[7rem_auto_1fr_auto]",
                    open ? "bg-wash/70" : "hover:bg-wash/60",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink",
                  )}
                >
                  <span className="hidden sm:block">
                    <ReasonBadge reason={item.reason} />
                  </span>
                  <span className="whitespace-nowrap font-mono text-xs text-ink-2">
                    {formatDateShort(item.date)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs text-ink">{item.name ?? "—"}</span>
                    <span className="block truncate font-mono text-[10px] text-ink-3">
                      {item.account_name ?? "—"}
                      <span className="sm:hidden"> · {REASON[item.reason].label}</span>
                    </span>
                  </span>
                  <span
                    className={cx(
                      "whitespace-nowrap text-right font-mono text-sm font-medium tabular-nums",
                      isInflow(item.amount) ? "text-pos" : "text-ink",
                    )}
                  >
                    {formatSignedAmount(item.amount, null)}
                  </span>
                </button>

                {open && (
                  <div className="border-t border-dashed border-rule-strong bg-wash/50 px-4 py-3">
                    {item.reason === "p2p" && (
                      <div className="space-y-2">
                        <p className={eyebrow}>
                          Payment-app transfer — what was it really?
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          {P2P_QUICK.map((c) => (
                            <Button key={c} size="sm" variant="secondary" onClick={() => ruleClass(item, c)}>
                              {TXN_CLASS[c].label}
                            </Button>
                          ))}
                          <MoreClasses exclude={P2P_QUICK} onPick={(c) => ruleClass(item, c)} />
                        </div>
                      </div>
                    )}

                    {item.reason === "unmatched_transfer" && (
                      <div className="space-y-3">
                        <div>
                          <p className={eyebrow}>
                            Counterpart candidates · same amount, other account, ±4 days
                          </p>
                          {cand === "loading" || cand === undefined ? (
                            <p className="mt-2 font-mono text-[10px] uppercase tracking-wide text-ink-3">
                              Searching…
                            </p>
                          ) : cand === "error" ? (
                            <p className="mt-2 text-xs text-neg">Candidate search failed — rule a class below instead.</p>
                          ) : cand.length === 0 ? (
                            <p className="mt-2 text-xs text-ink-2">
                              No counterpart found. The other leg may be at an unlinked
                              bank — rule a class below.
                            </p>
                          ) : (
                            <ul className="mt-2 divide-y divide-rule border border-rule bg-panel">
                              {cand.map(({ txn, delta }) => (
                                <li key={txn.id} className="flex items-center gap-3 px-3 py-1.5">
                                  <span className="whitespace-nowrap font-mono text-xs text-ink-2">
                                    {formatDateShort(txn.date)}
                                    <span className="ml-1 text-ink-3">
                                      ({delta === 0 ? "same day" : `${delta > 0 ? "+" : ""}${delta}d`})
                                    </span>
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-xs text-ink">{txn.name ?? "—"}</span>
                                    <span className="block truncate font-mono text-[10px] text-ink-3">
                                      {txn.account_name ?? "—"}
                                      {txn.account_mask ? ` ··${txn.account_mask}` : ""}
                                    </span>
                                  </span>
                                  <span
                                    className={cx(
                                      "whitespace-nowrap font-mono text-xs tabular-nums",
                                      isInflow(txn.amount) ? "text-pos" : "text-ink",
                                    )}
                                  >
                                    {formatSignedAmount(txn.amount, txn.currency)}
                                  </span>
                                  <Button size="sm" onClick={() => pair(item, txn)}>
                                    Pair
                                  </Button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div>
                          <p className={eyebrow}>Or rule what it was</p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            {UNMATCHED_QUICK.map((c) => (
                              <Button key={c} size="sm" variant="secondary" onClick={() => ruleClass(item, c)}>
                                {TXN_CLASS[c].label}
                              </Button>
                            ))}
                            <MoreClasses exclude={UNMATCHED_QUICK} onPick={(c) => ruleClass(item, c)} />
                          </div>
                        </div>
                      </div>
                    )}

                    {item.reason === "low_confidence" && (
                      <LowConfidenceActions item={item} onConfirm={ruleCategory} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

/** Overflow select for the less-common class rulings. */
function MoreClasses({
  exclude,
  onPick,
}: {
  exclude: RulableTxnClass[];
  onPick: (c: RulableTxnClass) => void;
}) {
  const rest = RULABLE_CLASSES.filter((c) => !exclude.includes(c));
  return (
    <Select
      aria-label="Other class rulings"
      className="w-36"
      value=""
      onChange={(e) => {
        const v = e.target.value as RulableTxnClass | "";
        if (v) onPick(v);
      }}
    >
      <option value="">More…</option>
      {rest.map((c) => (
        <option key={c} value={c}>
          {TXN_CLASS[c].label}
        </option>
      ))}
    </Select>
  );
}

function LowConfidenceActions({
  item,
  onConfirm,
}: {
  item: ReviewItem;
  onConfirm: (item: ReviewItem, category: string) => void;
}) {
  const [category, setCategory] = useState(item.pfc_primary ?? "");
  const guessed = item.pfc_primary;
  return (
    <div className="space-y-2">
      <p className={eyebrow}>
        Plaid guessed {guessed ?? "nothing"} with {item.pfc_confidence ?? "unknown"} confidence —
        confirm or fix it
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {guessed && (
          <Button size="sm" variant="secondary" onClick={() => onConfirm(item, guessed)}>
            Confirm {guessed}
          </Button>
        )}
        <input
          aria-label="Corrected category"
          className={cx(inputBase, "w-56")}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="category"
        />
        <Button
          size="sm"
          disabled={!category.trim() || category.trim() === guessed}
          onClick={() => onConfirm(item, category.trim())}
        >
          Set category
        </Button>
      </div>
      <p className="text-[10px] text-ink-3">
        Confirming writes the category as your ruling — the row leaves the inbox for good.
      </p>
    </div>
  );
}
