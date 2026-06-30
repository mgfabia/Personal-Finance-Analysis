"use client";

// Spending-by-category donut (Recharts — what Tremor's DonutChart wraps), with a
// centered total and a Tremor-style tooltip.
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { formatMoney } from "../../lib/format";

export interface DonutDatum {
  name: string;
  value: number;
}

// Recharts injects active/payload when content is a cloned element; typed loosely
// to stay decoupled from recharts' internal tooltip prop types across versions.
interface TooltipInjected {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string; payload?: { fill?: string } }>;
  currency: string | null;
}

function DonutTooltip({ active, payload, currency }: TooltipInjected) {
  if (!active || !payload?.length) return null;
  const slice = payload[0];
  return (
    <div className="rounded-md border border-gray-200 bg-white px-3 py-2 shadow-md">
      <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
        <span
          className="size-2 rounded-full"
          style={{ backgroundColor: slice.payload?.fill ?? slice.color }}
        />
        {slice.name}
      </p>
      <p className="mt-0.5 text-sm tabular-nums text-gray-600">
        {formatMoney(Number(slice.value), currency)}
      </p>
    </div>
  );
}

export function CategoryDonut({
  data,
  colors,
  currency,
}: {
  data: DonutDatum[];
  colors: string[];
  currency: string | null;
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0);

  if (data.length === 0) {
    return (
      <div className="flex h-[260px] items-center justify-center text-sm text-gray-400">
        No spending to show.
      </div>
    );
  }

  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={78}
            outerRadius={108}
            paddingAngle={2}
            stroke="none"
          >
            {data.map((d, i) => (
              <Cell key={d.name} fill={colors[i % colors.length]} />
            ))}
          </Pie>
          <Tooltip
            content={<DonutTooltip currency={currency} />}
            wrapperStyle={{ outline: "none" }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xs font-medium text-gray-400">Total spending</span>
        <span className="text-2xl font-semibold tabular-nums text-gray-900">
          {formatMoney(total, currency)}
        </span>
      </div>
    </div>
  );
}
