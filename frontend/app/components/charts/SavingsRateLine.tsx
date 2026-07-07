"use client";

// Savings rate per month — explicit (flows deliberately sent to savings /
// investments; saving-class blue, solid) vs implied (income simply not spent;
// ink, dashed). Line style doubles the color, so the pair survives CVD and
// grayscale. Months with no income arrive as null and break the line honestly.
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { TXN_CLASS } from "../../lib/classes";
import { formatPercent } from "../../lib/format";

export interface SavingsRatePoint {
  month: string; // display label
  explicit: number | null;
  implied: number | null;
}

const EXPLICIT_COLOR = TXN_CLASS.saving_investing.color;
const IMPLIED_COLOR = "#1c1a15"; // ink

interface TooltipInjected {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number | null }>;
  label?: string;
}

function RateTooltip({ active, payload, label }: TooltipInjected) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-sm border border-rule bg-panel px-3 py-2 shadow-sm">
      <p className="mb-1 font-mono text-[10px] font-medium uppercase tracking-wide text-ink-3">
        {label}
      </p>
      {payload.map((p) => (
        <p key={String(p.dataKey)} className="flex items-center gap-2 text-xs text-ink-2">
          <span
            className="h-0.5 w-3 shrink-0"
            style={{
              backgroundColor: p.dataKey === "explicit" ? EXPLICIT_COLOR : IMPLIED_COLOR,
            }}
          />
          <span>{p.dataKey === "explicit" ? "Explicit" : "Implied"}</span>
          <span className="ml-auto pl-4 font-mono tabular-nums text-ink">
            {p.value == null ? "—" : formatPercent(p.value)}
          </span>
        </p>
      ))}
    </div>
  );
}

export function SavingsRateLine({ data }: { data: SavingsRatePoint[] }) {
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
        <LineChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
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
            width={44}
            tick={{ fill: "#716d60", fontSize: 10, fontFamily: "var(--font-geist-mono)" }}
            tickFormatter={(v) => `${Math.round(Number(v) * 100)}%`}
          />
          <ReferenceLine y={0} stroke="#cdc8b8" strokeWidth={1} />
          <Tooltip
            content={<RateTooltip />}
            cursor={{ stroke: "#cdc8b8", strokeWidth: 1 }}
            wrapperStyle={{ outline: "none" }}
          />
          <Line
            dataKey="explicit"
            stroke={EXPLICIT_COLOR}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="implied"
            stroke={IMPLIED_COLOR}
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            activeDot={{ r: 4 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-2">
          <span className="h-0.5 w-4" style={{ backgroundColor: EXPLICIT_COLOR }} />
          Explicit (into savings)
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-2">
          <svg width="16" height="2" aria-hidden="true">
            <line x1="0" y1="1" x2="16" y2="1" stroke={IMPLIED_COLOR} strokeWidth="2" strokeDasharray="4 3" />
          </svg>
          Implied (not spent)
        </span>
      </div>
    </div>
  );
}
