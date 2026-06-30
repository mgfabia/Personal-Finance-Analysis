// Transaction feed — served from v_transactions (effective name/category, with
// overrides applied and removed tombstones filtered by the view). Tremor-style table.
import type { Transaction } from "../lib/api";
import { formatDate, formatSignedAmount, isInflow } from "../lib/format";
import { cx } from "../lib/utils";

export default function TransactionsTable({ transactions }: { transactions: Transaction[] }) {
  if (transactions.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-gray-400">
        No transactions yet. Add a bank to sync some.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-400">
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">Description</th>
            <th className="px-3 py-2 font-medium">Account</th>
            <th className="px-3 py-2 font-medium">Category</th>
            <th className="px-3 py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((t) => (
            <tr key={t.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
              <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">{formatDate(t.date)}</td>
              <td className="px-3 py-2.5 text-gray-900">
                {t.name ?? "—"}
                {t.pending && (
                  <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                    pending
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">
                {t.account_name ?? "—"}
                {t.account_mask ? ` ··${t.account_mask}` : ""}
              </td>
              <td className="px-3 py-2.5">
                {t.category ? (
                  <span className="rounded-md bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                    {t.category}
                  </span>
                ) : (
                  <span className="text-gray-400">—</span>
                )}
              </td>
              <td
                className={cx(
                  "whitespace-nowrap px-3 py-2.5 text-right tabular-nums",
                  isInflow(t.amount) ? "font-medium text-emerald-600" : "text-gray-900",
                )}
              >
                {formatSignedAmount(t.amount, t.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
