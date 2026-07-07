"use client";

// Where income went, per month — stacked bars of spending / debt / saving /
// unallocated (the four ways income leaves or stays). Colors come from the
// class taxonomy so the chart reads like the chips; `unallocated` is the
// deliberately recessive gray (its exact figures live in the ledger grid).
// A negative unallocated month (overspent) honestly stacks below the baseline.
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { TXN_CLASS, UNALLOCATED_COLOR } from "../../lib/classes";
import { formatMoney } from "../../lib/format";

export interface AllocationPoint {
  month: string; // display label
  spending: number;
  debt: number;
  saving: number;
  unallocated: number;
}

const SERIES = [
  { key: "spending" as const, label: TXN_CLASS.spending.label, color: TXN_CLASS.spending.color },
  { key: "debt" as const, label: TXN_CLASS.debt_payment.label, color: TXN_CLASS.debt_payment.color },
  { key: "saving" as const, label: TXN_CLASS.saving_investing.label, color: TXN_CLASS.saving_investing.color },
  { key: "unallocated" as const, label: "Unallocated", color: UNALLOCATED_COLOR },
];

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

interface TooltipInjected {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number; color?: string }>;
  label?: string;
  currency: string | null;
}

function StackTooltip({ active, payload, label, currency }: TooltipInjected) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-sm border border-rule bg-panel px-3 py-2 shadow-sm">
      <p className="mb-1 font-mono text-[10px] font-medium uppercase tracking-wide text-ink-3">
        {label}
      </p>
      {payload.map((p) => {
        const s = SERIES.find((x) => x.key === p.dataKey);
        return (
          <p key={String(p.dataKey)} className="flex items-center gap-2 text-xs text-ink-2">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: s?.color ?? p.color }} />
            <span>{s?.label ?? String(p.dataKey)}</span>
            <span className="ml-auto pl-4 font-mono tabular-nums text-ink">
              {formatMoney(Number(p.value ?? 0), currency)}
            </span>
          </p>
        );
      })}
    </div>
  );
}

export function AllocationBars({
  data,
  currency,
}: {
  data: AllocationPoint[];
  currency: string | null;
}) {
  if (data.length === 0) {
    return (
      <div className="flex h-[240px] items-center justify-center text-sm text-ink-3">
        No months on record yet.
      </div>
    );
  }

  return (
    <div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap="30%">
          <CartesianGrid stroke="#e8e5db" strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="month"
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#716d60", fontSize: 10, fontFamily: "var(--font-geist-mono)" }}
            dy={6}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={52}
            tick={{ fill: "#716d60", fontSize: 10, fontFamily: "var(--font-geist-mono)" }}
            tickFormatter={(v) => compactCurrency(Number(v), currency)}
          />
          <ReferenceLine y={0} stroke="#cdc8b8" strokeWidth={1} />
          <Tooltip
            content={<StackTooltip currency={currency} />}
            cursor={{ fill: "#f2f0e9", opacity: 0.6 }}
            wrapperStyle={{ outline: "none" }}
          />
          {SERIES.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId="alloc"
              fill={s.color}
              stroke="#faf9f6"
              strokeWidth={1}
              maxBarSize={28}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1" aria-hidden="false">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-2">
            <span className="size-2 rounded-full" style={{ backgroundColor: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
