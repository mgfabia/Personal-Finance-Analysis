"use client";

// Tremor-style BarList — ranked rows with an inline bar behind the label.
// Bars are sized relative to the largest value; optional per-row color matches
// the donut so a category reads the same in both.

export interface BarListItem {
  name: string;
  value: number;
}

export function BarList({
  data,
  valueFormatter = (n) => String(n),
  colorMap,
}: {
  data: BarListItem[];
  valueFormatter?: (value: number) => string;
  colorMap?: Record<string, string>;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <div className="space-y-1.5">
      {data.map((item) => (
        <div key={item.name} className="group relative flex items-center">
          <div
            className="absolute inset-y-0 left-0 rounded"
            style={{
              width: `${Math.max((item.value / max) * 100, 2)}%`,
              backgroundColor: colorMap?.[item.name] ?? "#bfdbfe",
              opacity: colorMap ? 0.25 : 1,
            }}
          />
          <div className="relative z-10 flex w-full items-center justify-between gap-3 px-2 py-1.5">
            <span className="truncate text-sm text-gray-900">{item.name}</span>
            <span className="shrink-0 text-sm tabular-nums text-gray-600">
              {valueFormatter(item.value)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
