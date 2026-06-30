// Chart color system. Tremor maps named colors to the Tailwind palette; we keep
// the same palette as hex (what Recharts wants for fill/stroke) and assign colors
// to categories deterministically so a category keeps its color across charts.

export const chartColors = [
  "#3b82f6", // blue-500
  "#10b981", // emerald-500
  "#8b5cf6", // violet-500
  "#f59e0b", // amber-500
  "#ec4899", // pink-500
  "#06b6d4", // cyan-500
  "#6366f1", // indigo-500
  "#84cc16", // lime-500
  "#f97316", // orange-500
  "#14b8a6", // teal-500
  "#a855f7", // purple-500
  "#ef4444", // red-500
];

/** Stable map from category label -> hex color (same order the slices render). */
export function assignColors(labels: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  labels.forEach((label, i) => {
    map[label] = chartColors[i % chartColors.length];
  });
  return map;
}
