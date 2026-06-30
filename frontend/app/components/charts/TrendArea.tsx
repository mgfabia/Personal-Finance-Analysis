"use client";

// Income vs. spending over time (Recharts AreaChart — what Tremor's AreaChart
// wraps). Minimal axes + gradient fills, Tremor-style.
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatMoney } from "../../lib/format";

export interface TrendPoint {
  month: string; // already formatted for display (e.g. "Apr 2026")
  income: number;
  spending: number;
}

function compactCurrency(n: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  } catch {
    return String(n);
  }
}

interface TrendTooltipInjected {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number; color?: string }>;
  label?: string;
  currency: string | null;
}

function TrendTooltip({ active, payload, label, currency }: TrendTooltipInjected) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-gray-200 bg-white px-3 py-2 shadow-md">
      <p className="mb-1 text-xs font-medium text-gray-500">{label}</p>
      {payload.map((p) => (
        <p key={String(p.dataKey)} className="flex items-center gap-2 text-sm text-gray-700">
          <span className="size-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="capitalize">{String(p.dataKey)}</span>
          <span className="ml-auto tabular-nums">{formatMoney(Number(p.value), currency)}</span>
        </p>
      ))}
    </div>
  );
}

export function TrendArea({
  data,
  currency,
}: {
  data: TrendPoint[];
  currency: string | null;
}) {
  if (data.length === 0) {
    return (
      <div className="flex h-[280px] items-center justify-center text-sm text-gray-400">
        Not enough history yet.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="fillIncome" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="fillSpending" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
        <XAxis
          dataKey="month"
          tickLine={false}
          axisLine={false}
          tick={{ fill: "#94a3b8", fontSize: 12 }}
          dy={8}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={56}
          tick={{ fill: "#94a3b8", fontSize: 12 }}
          tickFormatter={(v) => compactCurrency(Number(v), currency)}
        />
        <Tooltip
          content={<TrendTooltip currency={currency} />}
          wrapperStyle={{ outline: "none" }}
        />
        <Area
          type="monotone"
          dataKey="income"
          stroke="#10b981"
          strokeWidth={2}
          fill="url(#fillIncome)"
        />
        <Area
          type="monotone"
          dataKey="spending"
          stroke="#3b82f6"
          strokeWidth={2}
          fill="url(#fillSpending)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
