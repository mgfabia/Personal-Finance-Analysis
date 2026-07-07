"use client";

// Overview — the ledger. The hero is the months × measures grid (a real
// ledger: income / spending / debt / saving / net / unallocated / review),
// current month highlighted, totals footed. Above it, a KPI strip for the
// latest month; below, two compact instruments: where income went (stacked
// bars) and the savings rate (explicit vs implied).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AllocationBars, type AllocationPoint } from "../components/charts/AllocationBars";
import { SavingsRateLine, type SavingsRatePoint } from "../components/charts/SavingsRateLine";
import { useShell } from "../components/AppShell";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import {
  getCategorySummary,
  getMonthlySummary,
  getSavingsRate,
  UnauthorizedError,
  type CategorySummary,
  type MonthlySummary,
  type SavingsRateMonth,
} from "../lib/api";
import {
  currentMonthKey,
  formatLedger,
  formatMonth,
  formatMonthShort,
  formatMoney,
  formatPercent,
} from "../lib/format";
import { cx, eyebrow, focusRing } from "../lib/utils";

const TOP_CATEGORIES = 10;

function LedgerCell({ value, className }: { value: string; className?: string }) {
  const n = Number(value);
  return (
    <td
      className={cx(
        "whitespace-nowrap px-3 py-1.5 text-right font-mono text-xs tabular-nums",
        n < 0 ? "text-neg" : "text-ink",
        className,
      )}
    >
      {formatLedger(value)}
    </td>
  );
}

export default function OverviewPage() {
  const router = useRouter();
  const { linkVersion } = useShell();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [months, setMonths] = useState<MonthlySummary[]>([]);
  const [rates, setRates] = useState<SavingsRateMonth[]>([]);
  const [categories, setCategories] = useState<CategorySummary[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [monthly, savings, cats] = await Promise.all([
        getMonthlySummary(),
        getSavingsRate(),
        getCategorySummary(),
      ]);
      setMonths(monthly.months);
      setRates(savings.months);
      setCategories(cats.categories);
    } catch (e) {
      if (e instanceof UnauthorizedError) return router.replace("/login");
      setError(e instanceof Error ? e.message : "Failed to load the ledger.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load, linkVersion]);

  // --- derived -------------------------------------------------------------
  const currency = months[0]?.currency ?? "USD";
  const nowKey = currentMonthKey();
  const latest = months[0]; // newest first
  const latestRate = rates.find((r) => r.month === latest?.month);

  const allocation: AllocationPoint[] = useMemo(
    () =>
      [...months]
        .sort((a, b) => a.month.localeCompare(b.month))
        .map((m) => ({
          month: formatMonthShort(m.month),
          spending: Number(m.spending),
          debt: Number(m.debt_payments),
          saving: Number(m.saving_investing),
          unallocated: Number(m.unallocated),
        })),
    [months],
  );

  const ratePoints: SavingsRatePoint[] = useMemo(
    () =>
      [...rates]
        .sort((a, b) => a.month.localeCompare(b.month))
        .map((r) => ({
          month: formatMonthShort(r.month),
          explicit: r.savings_rate_explicit == null ? null : Number(r.savings_rate_explicit),
          implied: r.savings_rate_implied == null ? null : Number(r.savings_rate_implied),
        })),
    [rates],
  );

  const topCategories = useMemo(() => {
    if (!latest) return [];
    return categories
      .filter((c) => c.month === latest.month)
      .sort((a, b) => Number(b.spending) - Number(a.spending))
      .slice(0, TOP_CATEGORIES);
  }, [categories, latest]);

  const totals = useMemo(() => {
    const sum = (pick: (m: MonthlySummary) => string) =>
      months.reduce((s, m) => s + Number(pick(m)), 0);
    return {
      income: sum((m) => m.income),
      spending: sum((m) => m.spending),
      debt: sum((m) => m.debt_payments),
      saving: sum((m) => m.saving_investing),
      net: sum((m) => m.net),
      unallocated: sum((m) => m.unallocated),
      review: months.reduce((s, m) => s + m.needs_review_count, 0),
      txns: months.reduce((s, m) => s + m.txn_count, 0),
    };
  }, [months]);

  // --- render ----------------------------------------------------------------
  if (loading) {
    return <p className="py-24 text-center font-mono text-xs uppercase tracking-widest text-ink-3">Loading the ledger…</p>;
  }

  if (error) {
    return (
      <Card className="mx-auto mt-16 max-w-md text-center">
        <p className="text-sm text-neg">{error}</p>
        <Button variant="secondary" className="mt-4" onClick={() => void load()}>
          Try again
        </Button>
      </Card>
    );
  }

  if (months.length === 0) {
    return (
      <Card className="mx-auto mt-16 max-w-md text-center">
        <p className={eyebrow}>The ledger is empty</p>
        <p className="mt-2 text-sm text-ink-2">
          No transactions on record. Add a bank from the sidebar — a newly linked
          bank shows data after the next sync runs.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="font-mono text-base font-semibold uppercase tracking-[0.14em] text-ink">
          Overview
        </h1>
        <p className={eyebrow}>{formatMonth(latest.month)} · {currency}</p>
      </div>

      {/* KPI strip — latest month */}
      <Card className="p-0">
        <dl className="grid grid-cols-2 divide-rule sm:grid-cols-5 sm:divide-x">
          {[
            { label: "Income", value: formatMoney(latest.income, currency) },
            { label: "Spending", value: formatMoney(latest.spending, currency) },
            {
              label: "Net",
              value: formatMoney(latest.net, currency),
              tone: Number(latest.net) < 0 ? "text-neg" : "text-pos",
            },
            {
              label: "Savings rate",
              value: formatPercent(latestRate?.savings_rate_explicit ?? null),
              sub: `implied ${formatPercent(latestRate?.savings_rate_implied ?? null)}`,
            },
            {
              label: "To review",
              value: String(latest.needs_review_count),
              href: "/review",
            },
          ].map((kpi) => {
            const body = (
              <>
                <dt className={eyebrow}>{kpi.label}</dt>
                <dd className={cx("mt-1 font-mono text-xl font-semibold tabular-nums text-ink", kpi.tone)}>
                  {kpi.value}
                </dd>
                {kpi.sub && <dd className="mt-0.5 font-mono text-[10px] text-ink-3">{kpi.sub}</dd>}
              </>
            );
            return kpi.href ? (
              <Link
                key={kpi.label}
                href={kpi.href}
                className={cx("block px-4 py-3 hover:bg-wash", ...focusRing)}
              >
                {body}
              </Link>
            ) : (
              <div key={kpi.label} className="px-4 py-3">
                {body}
              </div>
            );
          })}
        </dl>
      </Card>

      {/* THE LEDGER GRID — hero */}
      <Card className="p-0">
        <div className="flex items-baseline justify-between border-b border-rule px-4 py-2.5">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-ink">
            Monthly ledger
          </h2>
          <p className={eyebrow}>figures in {currency} · negatives in parentheses</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-rule">
                <th className={cx(eyebrow, "px-3 py-2 text-left")}>Month</th>
                <th className={cx(eyebrow, "px-3 py-2 text-right")}>Income</th>
                <th className={cx(eyebrow, "px-3 py-2 text-right")}>Spending</th>
                <th className={cx(eyebrow, "px-3 py-2 text-right")}>Debt</th>
                <th className={cx(eyebrow, "px-3 py-2 text-right")}>Saving</th>
                <th className={cx(eyebrow, "px-3 py-2 text-right")}>Net</th>
                <th className={cx(eyebrow, "px-3 py-2 text-right")}>Unallocated</th>
                <th className={cx(eyebrow, "px-3 py-2 text-right")}>Review</th>
                <th className={cx(eyebrow, "px-3 py-2 text-right")}>Txns</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => {
                const isCurrent = m.month === nowKey;
                return (
                  <tr
                    key={m.month}
                    className={cx(
                      "border-b border-rule last:border-0",
                      isCurrent ? "bg-hilite" : "hover:bg-wash/60",
                    )}
                  >
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-ink">
                      {formatMonthShort(m.month)}
                      {isCurrent && (
                        <span className="ml-1.5 font-mono text-[9px] uppercase tracking-wide text-ink-3">
                          now
                        </span>
                      )}
                    </td>
                    <LedgerCell value={m.income} />
                    <LedgerCell value={m.spending} />
                    <LedgerCell value={m.debt_payments} />
                    <LedgerCell value={m.saving_investing} />
                    <LedgerCell value={m.net} className="font-medium" />
                    <LedgerCell value={m.unallocated} />
                    <td className="px-3 py-1.5 text-right">
                      {m.needs_review_count > 0 ? (
                        <Link
                          href="/review"
                          className={cx(
                            "inline-block rounded-sm bg-ink px-1.5 py-px font-mono text-[10px] font-semibold text-paper hover:bg-ink/80",
                            ...focusRing,
                          )}
                        >
                          {m.needs_review_count}
                        </Link>
                      ) : (
                        <span className="font-mono text-xs text-ink-3">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-xs tabular-nums text-ink-3">
                      {m.txn_count}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-rule-strong">
                <td className={cx(eyebrow, "px-3 py-2 text-left")}>Total</td>
                {[totals.income, totals.spending, totals.debt, totals.saving, totals.net, totals.unallocated].map(
                  (v, i) => (
                    <td
                      key={i}
                      className={cx(
                        "whitespace-nowrap px-3 py-2 text-right font-mono text-xs font-semibold tabular-nums",
                        v < 0 ? "text-neg" : "text-ink",
                      )}
                    >
                      {formatLedger(v)}
                    </td>
                  ),
                )}
                <td className="px-3 py-2 text-right font-mono text-xs font-semibold tabular-nums text-ink">
                  {totals.review || "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs font-semibold tabular-nums text-ink-3">
                  {totals.txns}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      {/* Instruments */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-ink">
            Where income went
          </h2>
          <div className="mt-3">
            <AllocationBars data={allocation} currency={currency} />
          </div>
        </Card>
        <Card>
          <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-ink">
            Savings rate
          </h2>
          <div className="mt-3">
            <SavingsRateLine data={ratePoints} />
          </div>
        </Card>
      </div>

      {/* Top categories — latest month */}
      <Card className="p-0">
        <div className="flex items-baseline justify-between border-b border-rule px-4 py-2.5">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-ink">
            Top categories
          </h2>
          <p className={eyebrow}>{formatMonth(latest.month)}</p>
        </div>
        {topCategories.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-3">
            No categorized spending this month yet.
          </p>
        ) : (
          <table className="w-full">
            <tbody>
              {topCategories.map((c) => (
                <tr key={c.category} className="border-b border-rule last:border-0 hover:bg-wash/60">
                  <td className="px-4 py-1.5 text-xs text-ink">
                    <Link
                      href={`/transactions?category=${encodeURIComponent(c.category)}`}
                      className={cx("hover:underline", ...focusRing)}
                    >
                      {c.category}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-[10px] tabular-nums text-ink-3">
                    {c.txn_count} txn{c.txn_count === 1 ? "" : "s"}
                  </td>
                  <td
                    className={cx(
                      "whitespace-nowrap px-4 py-1.5 text-right font-mono text-xs tabular-nums",
                      Number(c.spending) < 0 ? "text-neg" : "text-ink",
                    )}
                  >
                    {formatLedger(c.spending)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
