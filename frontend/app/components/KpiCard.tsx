// KPI tile — Card + Metric/Text in Tremor's vocabulary (income / spending / net).
import type { ReactNode } from "react";

import { Card } from "./ui/Card";
import { cx } from "../lib/utils";

export function KpiCard({
  label,
  value,
  sublabel,
  accent,
  icon,
}: {
  label: string;
  value: string;
  sublabel?: string;
  accent?: string; // tailwind text color class for the value
  icon?: ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-500">{label}</p>
        {icon}
      </div>
      <p className={cx("mt-2 text-3xl font-semibold tabular-nums text-gray-900", accent)}>
        {value}
      </p>
      {sublabel && <p className="mt-1 text-xs text-gray-400">{sublabel}</p>}
    </Card>
  );
}
