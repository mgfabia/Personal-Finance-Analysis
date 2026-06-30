"use client";

// Dashboard — Phase 8 core (Tremor-style). Client-rendered because auth is a
// localStorage JWT attached as a bearer header. Guards on auth, loads the read
// API in parallel, and composes Tremor tiles: KPI cards, a spending/income trend
// area chart, a category donut + ranked BarList, and the transactions table.

import {
  RiArrowDownLine,
  RiArrowUpLine,
  RiWallet3Line,
} from "@remixicon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { BarList } from "./components/BarList";
import { CategoryDonut } from "./components/charts/CategoryDonut";
import { TrendArea } from "./components/charts/TrendArea";
import { AccountSelect } from "./components/AccountSelect";
import { KpiCard } from "./components/KpiCard";
import LinkButton from "./components/LinkButton";
import TransactionsTable from "./components/TransactionsTable";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import {
  clearToken,
  getAccounts,
  getCategorySummary,
  getMonthlySummary,
  getTransactions,
  isAuthenticated,
  UnauthorizedError,
  type Account,
  type CategorySummary,
  type MonthlySummary,
  type Transaction,
} from "./lib/api";
import { assignColors, chartColors } from "./lib/chartUtils";
import { formatMoney } from "./lib/format";

const DONUT_LIMIT = 7; // top-N categories; the rest fold into "Other"

function monthShort(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

export default function Home() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [months, setMonths] = useState<MonthlySummary[]>([]);
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountFilter, setAccountFilter] = useState("");
  const [txnLoading, setTxnLoading] = useState(false);

  const loadTransactions = useCallback(
    async (accountId: string) => {
      setTxnLoading(true);
      try {
        const txns = await getTransactions({ limit: 100, accountId: accountId || undefined });
        setTransactions(txns.transactions);
      } catch (e) {
        if (e instanceof UnauthorizedError) return router.replace("/login");
        setError(e instanceof Error ? e.message : "Failed to load transactions.");
      } finally {
        setTxnLoading(false);
      }
    },
    [router],
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [txns, monthly, cats, accts] = await Promise.all([
        getTransactions({ limit: 100 }),
        getMonthlySummary(),
        getCategorySummary(),
        getAccounts(),
      ]);
      setTransactions(txns.transactions);
      setMonths(monthly.months);
      setCategories(cats.categories);
      setAccounts(accts.accounts);
    } catch (e) {
      if (e instanceof UnauthorizedError) return router.replace("/login");
      setError(e instanceof Error ? e.message : "Failed to load data.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
      return;
    }
    setReady(true);
    void loadData();
  }, [router, loadData]);

  function onAccountChange(value: string) {
    setAccountFilter(value);
    void loadTransactions(value);
  }

  const onLinked = useCallback(() => {
    setAccountFilter("");
    void loadData();
  }, [loadData]);

  function signOut() {
    clearToken();
    router.replace("/login");
  }

  // --- derived figures ----------------------------------------------------
  const currency =
    months[0]?.currency ?? categories[0]?.currency ?? "USD";

  const totals = useMemo(() => {
    const income = months.reduce((s, m) => s + Number(m.income), 0);
    const spending = months.reduce((s, m) => s + Number(m.spending), 0);
    return { income, spending, net: income - spending };
  }, [months]);

  const trend = useMemo(
    () =>
      [...months]
        .sort((a, b) => a.month.localeCompare(b.month))
        .map((m) => ({
          month: monthShort(m.month),
          income: Number(m.income),
          spending: Number(m.spending),
        })),
    [months],
  );

  // Aggregate category spending across all months, rank, fold the tail into "Other".
  const { donutData, barData, colorMap } = useMemo(() => {
    const byCat = new Map<string, number>();
    for (const c of categories) {
      byCat.set(c.category, (byCat.get(c.category) ?? 0) + Number(c.spending));
    }
    const ranked = [...byCat.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    const top = ranked.slice(0, DONUT_LIMIT);
    const rest = ranked.slice(DONUT_LIMIT);
    const donut =
      rest.length > 0
        ? [...top, { name: "Other", value: rest.reduce((s, r) => s + r.value, 0) }]
        : top;

    return {
      donutData: donut,
      barData: top.slice(0, 6),
      colorMap: assignColors(donut.map((d) => d.name)),
    };
  }, [categories]);

  if (!ready) return null;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
            Personal Finance
          </h1>
          <p className="text-sm text-gray-500">Your accounts at a glance</p>
        </div>
        <div className="flex items-center gap-2">
          <LinkButton onLinked={onLinked} />
          <Button variant="ghost" onClick={signOut}>Sign out</Button>
        </div>
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="py-20 text-center text-sm text-gray-400">Loading…</p>
      ) : (
        <div className="mt-6 space-y-6">
          {/* KPI row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <KpiCard
              label="Income"
              value={formatMoney(totals.income, currency)}
              accent="text-emerald-600"
              icon={<RiArrowUpLine className="size-5 text-emerald-500" />}
            />
            <KpiCard
              label="Spending"
              value={formatMoney(totals.spending, currency)}
              icon={<RiArrowDownLine className="size-5 text-blue-500" />}
            />
            <KpiCard
              label="Net"
              value={formatMoney(totals.net, currency)}
              accent={totals.net >= 0 ? "text-emerald-600" : "text-red-600"}
              icon={<RiWallet3Line className="size-5 text-gray-400" />}
            />
          </div>

          {/* Trend */}
          <Card>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-gray-900">Income vs. spending</h2>
              <div className="flex items-center gap-4 text-xs text-gray-500">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-emerald-500" /> Income
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-blue-500" /> Spending
                </span>
              </div>
            </div>
            <div className="mt-4">
              <TrendArea data={trend} currency={currency} />
            </div>
          </Card>

          {/* Category breakdown */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <h2 className="text-sm font-medium text-gray-900">Spending by category</h2>
              <div className="mt-2">
                <CategoryDonut data={donutData} colors={chartColors} currency={currency} />
              </div>
            </Card>
            <Card>
              <h2 className="text-sm font-medium text-gray-900">Top categories</h2>
              <div className="mt-4">
                {barData.length > 0 ? (
                  <BarList
                    data={barData}
                    colorMap={colorMap}
                    valueFormatter={(n) => formatMoney(n, currency)}
                  />
                ) : (
                  <p className="py-8 text-center text-sm text-gray-400">No spending yet.</p>
                )}
              </div>
            </Card>
          </div>

          {/* Transactions */}
          <Card className="p-0">
            <div className="flex items-center justify-between gap-3 border-b border-gray-100 p-5">
              <h2 className="text-sm font-medium text-gray-900">Recent transactions</h2>
              {accounts.length > 0 && (
                <AccountSelect accounts={accounts} value={accountFilter} onChange={onAccountChange} />
              )}
            </div>
            <div className="p-2 sm:p-4">
              {txnLoading ? (
                <p className="py-10 text-center text-sm text-gray-400">Loading…</p>
              ) : (
                <TransactionsTable transactions={transactions} />
              )}
            </div>
          </Card>
        </div>
      )}
    </main>
  );
}
