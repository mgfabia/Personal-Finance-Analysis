"use client";

// Transactions — the power table. Every read-API filter is exposed (class,
// category, account, date range, pending, tags with OR semantics); rows expand
// into the inline editor (name / category / notes / class override / hidden /
// tags). Class chips carry the row's txn_class with its source mark; paired
// legs show their counterpart account.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { useShell } from "../../components/AppShell";
import { TxnEditor } from "../../components/TxnEditor";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { ClassChip } from "../../components/ui/ClassChip";
import { Select } from "../../components/ui/Select";
import { TagChip } from "../../components/ui/TagChip";
import {
  getAccounts,
  getCategorySummary,
  getTags,
  getTransactions,
  UnauthorizedError,
  type Account,
  type Tag,
  type Transaction,
  type TxnClass,
} from "../../lib/api";
import { TXN_CLASS, TXN_CLASS_ORDER } from "../../lib/classes";
import { formatDateShort, formatSignedAmount, isInflow } from "../../lib/format";
import { cx, eyebrow, focusRing, inputBase } from "../../lib/utils";

const PAGE_SIZE = 100;

interface Filters {
  txnClass: TxnClass | "";
  accountId: string;
  category: string;
  startDate: string;
  endDate: string;
  pending: "" | "true" | "false";
  tags: string[];
}

const EMPTY_FILTERS: Filters = {
  txnClass: "",
  accountId: "",
  category: "",
  startDate: "",
  endDate: "",
  pending: "",
  tags: [],
};

function isTxnClass(v: string): v is TxnClass {
  return v in TXN_CLASS;
}

function TransactionsInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { refreshReview, linkVersion } = useShell();

  // Seed filters from the URL once (tag links from /tags, category links from
  // the overview, class links from anywhere).
  const [filters, setFilters] = useState<Filters>(() => {
    const cls = searchParams.get("txn_class") ?? "";
    return {
      ...EMPTY_FILTERS,
      txnClass: isTxnClass(cls) ? cls : "",
      accountId: searchParams.get("account_id") ?? "",
      category: searchParams.get("category") ?? "",
      tags: searchParams.getAll("tag"),
    };
  });
  const [offset, setOffset] = useState(0);

  const [rows, setRows] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // Reference data (accounts, tag registry, known categories) — once per link.
  useEffect(() => {
    Promise.all([getAccounts(), getTags(), getCategorySummary()])
      .then(([a, t, c]) => {
        setAccounts(a.accounts);
        setAllTags(t.tags);
        setCategories([...new Set(c.categories.map((x) => x.category))].sort());
      })
      .catch((e) => {
        if (e instanceof UnauthorizedError) return router.replace("/login");
        setError(e instanceof Error ? e.message : "Failed to load filters.");
      });
  }, [router, linkVersion]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getTransactions({
        limit: PAGE_SIZE,
        offset,
        accountId: filters.accountId || undefined,
        txnClass: filters.txnClass || undefined,
        category: filters.category || undefined,
        startDate: filters.startDate || undefined,
        endDate: filters.endDate || undefined,
        pending: filters.pending === "" ? undefined : filters.pending === "true",
        tags: filters.tags.length ? filters.tags : undefined,
      });
      setRows(res.transactions);
    } catch (e) {
      if (e instanceof UnauthorizedError) return router.replace("/login");
      setError(e instanceof Error ? e.message : "Failed to load transactions.");
    } finally {
      setLoading(false);
    }
  }, [router, filters, offset]);

  useEffect(() => {
    void load();
  }, [load, linkVersion]);

  function patchFilters(patch: Partial<Filters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setOffset(0);
    setOpenId(null);
  }

  const activeFilterCount = useMemo(
    () =>
      (filters.txnClass ? 1 : 0) +
      (filters.accountId ? 1 : 0) +
      (filters.category ? 1 : 0) +
      (filters.startDate ? 1 : 0) +
      (filters.endDate ? 1 : 0) +
      (filters.pending ? 1 : 0) +
      filters.tags.length,
    [filters],
  );

  const onSaved = useCallback(() => {
    setOpenId(null);
    void load();
    refreshReview(); // an override can clear rows from the review queue
  }, [load, refreshReview]);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="font-mono text-base font-semibold uppercase tracking-[0.14em] text-ink">
          Transactions
        </h1>
        {activeFilterCount > 0 && (
          <button
            onClick={() => patchFilters(EMPTY_FILTERS)}
            className={cx("font-mono text-[10px] uppercase tracking-wide text-ink-2 underline hover:text-ink", ...focusRing)}
          >
            Clear {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"}
          </button>
        )}
      </div>

      {/* Class filter — the taxonomy as a chip row */}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by class">
        <button
          onClick={() => patchFilters({ txnClass: "" })}
          aria-pressed={filters.txnClass === ""}
          className={cx(
            "rounded-sm border px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wide",
            filters.txnClass === ""
              ? "border-ink bg-ink text-paper"
              : "border-rule-strong bg-panel text-ink-2 hover:bg-wash",
            ...focusRing,
          )}
        >
          All
        </button>
        {TXN_CLASS_ORDER.map((c) => {
          const on = filters.txnClass === c;
          const spec = TXN_CLASS[c];
          return (
            <button
              key={c}
              onClick={() => patchFilters({ txnClass: on ? "" : c })}
              aria-pressed={on}
              className={cx(
                "rounded-sm border px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wide",
                spec.quarantine && "border-dashed",
                ...focusRing,
              )}
              style={
                on
                  ? { color: "#faf9f6", backgroundColor: spec.color, borderColor: spec.color }
                  : { color: spec.text, borderColor: `${spec.color}59`, backgroundColor: `${spec.color}12` }
              }
            >
              {spec.label}
            </button>
          );
        })}
      </div>

      {/* Dimension filters */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Select
          aria-label="Filter by account"
          value={filters.accountId}
          onChange={(e) => patchFilters({ accountId: e.target.value })}
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {(a.effective_name ?? "Account") + (a.mask ? ` ··${a.mask}` : "")}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by category"
          value={filters.category}
          onChange={(e) => patchFilters({ category: e.target.value })}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <input
          type="date"
          aria-label="From date"
          className={inputBase}
          value={filters.startDate}
          onChange={(e) => patchFilters({ startDate: e.target.value })}
        />
        <input
          type="date"
          aria-label="To date"
          className={inputBase}
          value={filters.endDate}
          onChange={(e) => patchFilters({ endDate: e.target.value })}
        />
        <Select
          aria-label="Filter by pending"
          value={filters.pending}
          onChange={(e) => patchFilters({ pending: e.target.value as Filters["pending"] })}
        >
          <option value="">Posted + pending</option>
          <option value="true">Pending only</option>
          <option value="false">Posted only</option>
        </Select>
        {allTags.length > 0 && (
          <Select
            aria-label="Add tag filter"
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (id && !filters.tags.includes(id)) patchFilters({ tags: [...filters.tags, id] });
            }}
          >
            <option value="">Tag…</option>
            {allTags
              .filter((t) => !filters.tags.includes(t.id))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </Select>
        )}
      </div>

      {/* Active tag filters (OR) */}
      {filters.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={eyebrow}>Tagged any of:</span>
          {filters.tags.map((id) => {
            const t = allTags.find((x) => x.id === id);
            return (
              <button
                key={id}
                onClick={() => patchFilters({ tags: filters.tags.filter((x) => x !== id) })}
                title="Remove tag filter"
                className={cx(
                  "rounded-sm border border-ink bg-ink px-1.5 py-px font-mono text-[10px] text-paper hover:bg-ink/80",
                  ...focusRing,
                )}
              >
                {t?.name ?? "tag"} ×
              </button>
            );
          })}
        </div>
      )}

      {error && <p className="text-sm text-neg">{error}</p>}

      {/* The table */}
      <Card className="p-0">
        {loading ? (
          <p className="py-16 text-center font-mono text-xs uppercase tracking-widest text-ink-3">
            Loading…
          </p>
        ) : rows.length === 0 ? (
          <p className="py-16 text-center text-sm text-ink-3">
            {activeFilterCount > 0
              ? "No transactions match these filters."
              : "No transactions yet. Add a bank to sync some."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-rule">
                  <th className={cx(eyebrow, "px-3 py-2 text-left")}>Date</th>
                  <th className={cx(eyebrow, "px-3 py-2 text-left")}>Description</th>
                  <th className={cx(eyebrow, "hidden px-3 py-2 text-left md:table-cell")}>Account</th>
                  <th className={cx(eyebrow, "px-3 py-2 text-left")}>Class</th>
                  <th className={cx(eyebrow, "hidden px-3 py-2 text-left lg:table-cell")}>Category</th>
                  <th className={cx(eyebrow, "hidden px-3 py-2 text-left xl:table-cell")}>Tags</th>
                  <th className={cx(eyebrow, "px-3 py-2 text-right")}>Amount</th>
                </tr>
              </thead>
              {rows.map((t) => {
                const open = openId === t.id;
                return (
                  <tbody key={t.id}>
                    <tr
                      tabIndex={0}
                      onClick={() => setOpenId(open ? null : t.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setOpenId(open ? null : t.id);
                        }
                      }}
                      aria-expanded={open}
                      className={cx(
                        "cursor-pointer border-b border-rule",
                        open ? "border-b-0 bg-wash/70" : "hover:bg-wash/60",
                        t.is_hidden && "opacity-50",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink",
                      )}
                    >
                      <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-ink-2">
                        {formatDateShort(t.date)}
                      </td>
                      <td className="max-w-[16rem] px-3 py-1.5 text-xs text-ink">
                        <span className="block truncate">
                          {t.name ?? "—"}
                          {t.pending && (
                            <span className="ml-1.5 font-mono text-[9px] uppercase tracking-wide text-ink-3">
                              pending
                            </span>
                          )}
                          {t.is_hidden && (
                            <span className="ml-1.5 font-mono text-[9px] uppercase tracking-wide text-ink-3">
                              hidden
                            </span>
                          )}
                        </span>
                        {t.counterpart_account_name && (
                          <span className="block truncate font-mono text-[10px] text-ink-3">
                            ⇄ {t.counterpart_account_name}
                          </span>
                        )}
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-1.5 text-xs text-ink-2 md:table-cell">
                        {t.account_name ?? "—"}
                        {t.account_mask ? ` ··${t.account_mask}` : ""}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5">
                        <ClassChip txnClass={t.txn_class} source={t.txn_class_source} />
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-1.5 font-mono text-[10px] text-ink-2 lg:table-cell">
                        {t.category ?? "—"}
                      </td>
                      <td className="hidden px-3 py-1.5 xl:table-cell">
                        <span className="flex flex-wrap gap-1">
                          {t.tags.map((name, i) => {
                            const tag = allTags.find((x) => x.id === t.tag_ids[i]);
                            return <TagChip key={t.tag_ids[i] ?? name} name={name} color={tag?.color} />;
                          })}
                        </span>
                      </td>
                      <td
                        className={cx(
                          "whitespace-nowrap px-3 py-1.5 text-right font-mono text-xs tabular-nums",
                          isInflow(t.amount) ? "font-medium text-pos" : "text-ink",
                        )}
                      >
                        {formatSignedAmount(t.amount, t.currency)}
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b border-rule">
                        <td colSpan={7} className="p-0">
                          <TxnEditor
                            txn={t}
                            allTags={allTags}
                            categories={categories}
                            onSaved={onSaved}
                            onClose={() => setOpenId(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </tbody>
                );
              })}
            </table>
          </div>
        )}

        {/* Pagination */}
        {!loading && (rows.length === PAGE_SIZE || offset > 0) && (
          <div className="flex items-center justify-between border-t border-rule px-3 py-2">
            <p className="font-mono text-[10px] uppercase tracking-wide text-ink-3">
              rows {offset + 1}–{offset + rows.length}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={offset === 0}
                onClick={() => {
                  setOffset(Math.max(0, offset - PAGE_SIZE));
                  setOpenId(null);
                }}
              >
                Newer
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={rows.length < PAGE_SIZE}
                onClick={() => {
                  setOffset(offset + PAGE_SIZE);
                  setOpenId(null);
                }}
              >
                Older
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function TransactionsPage() {
  // useSearchParams requires a Suspense boundary for prerendering.
  return (
    <Suspense fallback={null}>
      <TransactionsInner />
    </Suspense>
  );
}
