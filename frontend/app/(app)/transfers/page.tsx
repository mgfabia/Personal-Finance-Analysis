"use client";

// Transfers — the pair ledger. One row per matched pair (both legs): from → to,
// amount, dates with the day lag, kind, source (auto matcher vs user), and the
// corroboration marker. Unlink and Reject are separated behind a confirm step
// because they mean different things: unlink frees the legs (an auto pair may
// be re-proposed immediately by the matcher), reject tombstones the pair so it
// is never proposed again.

import { RiCheckLine } from "@remixicon/react";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { useShell } from "../../components/AppShell";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import {
  deleteTransfer,
  getTransfers,
  UnauthorizedError,
  type Transfer,
} from "../../lib/api";
import { TRANSFER_KIND } from "../../lib/classes";
import { dayDiff, formatDateShort, formatMoney } from "../../lib/format";
import { cx, eyebrow } from "../../lib/utils";

function KindBadge({ kind }: { kind: Transfer["kind"] }) {
  const spec = TRANSFER_KIND[kind];
  return (
    <span
      className="inline-flex whitespace-nowrap rounded-sm border px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wide"
      style={{ color: spec.text, borderColor: `${spec.color}59`, backgroundColor: `${spec.color}12` }}
    >
      {spec.label}
    </span>
  );
}

export default function TransfersPage() {
  const router = useRouter();
  const { refreshReview, linkVersion } = useShell();

  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getTransfers();
      setTransfers(res.transfers);
    } catch (e) {
      if (e instanceof UnauthorizedError) return router.replace("/login");
      setError(e instanceof Error ? e.message : "Failed to load transfers.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load, linkVersion]);

  async function unlink(id: string, reject: boolean) {
    setBusyId(id);
    setError(null);
    try {
      await deleteTransfer(id, reject);
      setConfirmId(null);
      await load();
      refreshReview(); // freed legs can land back in the review queue
    } catch (e) {
      if (e instanceof UnauthorizedError) return router.replace("/login");
      setError(e instanceof Error ? e.message : "Could not unlink the pair.");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <p className="py-24 text-center font-mono text-xs uppercase tracking-widest text-ink-3">
        Loading transfers…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="font-mono text-base font-semibold uppercase tracking-[0.14em] text-ink">
          Transfers
        </h1>
        {transfers.length > 0 && (
          <p className={eyebrow}>{transfers.length} matched pairs</p>
        )}
      </div>

      {error && <p className="text-sm text-neg">{error}</p>}

      {transfers.length === 0 ? (
        <Card className="py-16 text-center">
          <p className={eyebrow}>No matched transfers</p>
          <p className="mt-2 text-sm text-ink-2">
            Pairs appear here when the matcher links both legs of a transfer —
            or when you pair one from the review inbox.
          </p>
        </Card>
      ) : (
        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-rule">
                  <th className={cx(eyebrow, "px-3 py-2 text-left")}>Kind</th>
                  <th className={cx(eyebrow, "px-3 py-2 text-left")}>From → To</th>
                  <th className={cx(eyebrow, "px-3 py-2 text-right")}>Amount</th>
                  <th className={cx(eyebrow, "px-3 py-2 text-left")}>Out</th>
                  <th className={cx(eyebrow, "px-3 py-2 text-left")}>Lag</th>
                  <th className={cx(eyebrow, "px-3 py-2 text-left")}>Source</th>
                  <th className={cx(eyebrow, "px-3 py-2 text-center")} title="Both legs corroborate each other (names/institutions agree)">
                    Corr.
                  </th>
                  <th className={cx(eyebrow, "px-3 py-2 text-right")}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              {transfers.map((tr) => {
                const lag = dayDiff(tr.out_date, tr.in_date);
                const confirming = confirmId === tr.id;
                return (
                  <tbody key={tr.id}>
                    <tr className={cx("border-b border-rule", confirming ? "border-b-0 bg-wash/70" : "hover:bg-wash/60")}>
                      <td className="whitespace-nowrap px-3 py-1.5">
                        <KindBadge kind={tr.kind} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-xs text-ink">
                        {tr.from_account ?? "—"}
                        <span className="mx-1.5 text-ink-3">→</span>
                        {tr.to_account ?? "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-xs tabular-nums text-ink">
                        {formatMoney(tr.amount, null)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-ink-2">
                        {formatDateShort(tr.out_date)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-ink-3">
                        {lag === 0 ? "same day" : `+${lag}d`}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-2">
                        {tr.source === "user" ? "user ✱" : "auto"}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        {tr.corroborated ? (
                          <RiCheckLine className="mx-auto size-3.5 text-pos" aria-label="corroborated" />
                        ) : (
                          <span className="font-mono text-xs text-ink-3" aria-label="not corroborated">
                            —
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmId(confirming ? null : tr.id)}
                        >
                          Unlink…
                        </Button>
                      </td>
                    </tr>
                    {confirming && (
                      <tr className="border-b border-rule">
                        <td colSpan={8} className="p-0">
                          <div className="border-t border-dashed border-rule-strong bg-wash/50 px-4 py-3">
                            <p className="text-xs text-ink-2">
                              <span className="font-medium text-ink">Unlink</span> frees both
                              legs — for a pair the matcher found on its own, it may be
                              re-proposed immediately on the next rebuild.{" "}
                              <span className="font-medium text-ink">Reject</span> also
                              tombstones this exact pair so the matcher never proposes it
                              again. Either way the legs return to normal classification
                              (and may land in the review inbox).
                            </p>
                            <div className="mt-2.5 flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant="secondary"
                                isLoading={busyId === tr.id}
                                onClick={() => void unlink(tr.id, false)}
                              >
                                Unlink only
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                isLoading={busyId === tr.id}
                                onClick={() => void unlink(tr.id, true)}
                              >
                                Reject pair
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busyId === tr.id}
                                onClick={() => setConfirmId(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                );
              })}
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
