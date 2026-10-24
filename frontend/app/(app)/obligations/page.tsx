"use client";

// Obligations — recurring commitments the user declares (rent, ...). Each one
// says "every month around day D, ~$A goes out matching these filters; N people
// pay me back ~$S each". The backend matcher groups each month's payment and
// reimbursements into one event; here you define them and audit the months:
// what was paid, what came back, the net, and whether anything is missing.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { useShell } from "../../components/AppShell";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Select } from "../../components/ui/Select";
import {
  createObligation,
  deleteObligation,
  getAccounts,
  getCategorySummary,
  getObligations,
  updateObligation,
  UnauthorizedError,
  type Account,
  type Obligation,
  type ObligationInput,
  type ObligationStatus,
} from "../../lib/api";
import { formatDateShort, formatMoney, formatMonthShort } from "../../lib/format";
import { cx, eyebrow, inputBase } from "../../lib/utils";

// Form state is all strings (inputs); converted to ObligationInput on submit.
interface FormState {
  name: string;
  category: string;
  accountId: string;
  matchText: string;
  amount: string;
  amountTolerance: string;
  dayOfMonth: string;
  dayWindow: string;
  reimbursementCount: string;
  reimbursementAmount: string;
  reimbursementTolerance: string;
  startMonth: string; // YYYY-MM (input type="month")
  endMonth: string;
  active: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  category: "RENT_AND_UTILITIES",
  accountId: "",
  matchText: "",
  amount: "",
  amountTolerance: "0",
  dayOfMonth: "1",
  dayWindow: "5",
  reimbursementCount: "0",
  reimbursementAmount: "",
  reimbursementTolerance: "0",
  startMonth: "",
  endMonth: "",
  active: true,
};

function toForm(ob: Obligation): FormState {
  return {
    name: ob.name,
    category: ob.category,
    accountId: ob.account_id ?? "",
    matchText: ob.match_text ?? "",
    amount: String(Number(ob.amount)),
    amountTolerance: String(Number(ob.amount_tolerance)),
    dayOfMonth: String(ob.day_of_month),
    dayWindow: String(ob.day_window),
    reimbursementCount: String(ob.reimbursement_count),
    reimbursementAmount: ob.reimbursement_amount ? String(Number(ob.reimbursement_amount)) : "",
    reimbursementTolerance: String(Number(ob.reimbursement_tolerance)),
    startMonth: ob.start_month?.slice(0, 7) ?? "",
    endMonth: ob.end_month?.slice(0, 7) ?? "",
    active: ob.active,
  };
}

/** Validate and convert; returns an error message instead when invalid. */
function toInput(f: FormState): ObligationInput | string {
  const num = (s: string) => (s.trim() === "" ? NaN : Number(s));
  const amount = num(f.amount);
  const count = num(f.reimbursementCount);
  const share = num(f.reimbursementAmount);
  const day = num(f.dayOfMonth);
  const window = num(f.dayWindow);
  if (!f.name.trim()) return "Give the obligation a name.";
  if (!f.category.trim()) return "Pick a category.";
  if (!(amount > 0)) return "Amount must be greater than 0.";
  if (!(Number.isInteger(day) && day >= 1 && day <= 31)) return "Day of month must be 1–31.";
  if (!(Number.isInteger(window) && window >= 0 && window <= 10)) return "Window must be 0–10 days.";
  if (!(Number.isInteger(count) && count >= 0 && count <= 20)) return "Reimbursements must be 0–20.";
  if (count > 0 && !(share > 0)) return "Set the amount each person pays back.";
  if (f.startMonth && f.endMonth && f.endMonth < f.startMonth) return "End month is before start month.";
  return {
    name: f.name.trim(),
    category: f.category.trim(),
    account_id: f.accountId || null,
    match_text: f.matchText.trim() || null,
    amount,
    amount_tolerance: num(f.amountTolerance) || 0,
    day_of_month: day,
    day_window: window,
    reimbursement_count: count,
    reimbursement_amount: count > 0 ? share : null,
    reimbursement_tolerance: count > 0 ? num(f.reimbursementTolerance) || 0 : 0,
    start_month: f.startMonth ? `${f.startMonth}-01` : null,
    end_month: f.endMonth ? `${f.endMonth}-01` : null,
    active: f.active,
  };
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

const STATUS_STYLE: Record<ObligationStatus, { label: string; className: string }> = {
  complete: { label: "Complete", className: "border-pos/40 text-pos" },
  upcoming: { label: "Upcoming", className: "border-rule-strong text-ink-3" },
  partial: { label: "Partial", className: "border-dashed border-neg/50 text-neg" },
  missing: { label: "Missing", className: "border-neg/50 text-neg" },
};

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className={eyebrow}>{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function ObligationForm({
  initial,
  accounts,
  categories,
  submitLabel,
  showActive,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: FormState;
  accounts: Account[];
  categories: string[];
  submitLabel: string;
  showActive: boolean;
  busy: boolean;
  onSubmit: (input: ObligationInput) => void;
  onCancel?: () => void;
}) {
  const [f, setF] = useState<FormState>(initial);
  const [invalid, setInvalid] = useState<string | null>(null);
  const set = (patch: Partial<FormState>) => setF((s) => ({ ...s, ...patch }));
  const hasReimbursements = Number(f.reimbursementCount) > 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const input = toInput(f);
    if (typeof input === "string") return setInvalid(input);
    setInvalid(null);
    onSubmit(input);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name">
          <input className={inputBase} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Rent" />
        </Field>
        <Field label="Category">
          <input
            className={inputBase}
            value={f.category}
            onChange={(e) => set({ category: e.target.value })}
            list="obligation-categories"
          />
          <datalist id="obligation-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        <Field label="Account">
          <Select value={f.accountId} onChange={(e) => set({ accountId: e.target.value })}>
            <option value="">Any account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {(a.effective_name ?? "Account") + (a.mask ? ` ··${a.mask}` : "")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Description contains">
          <input
            className={inputBase}
            value={f.matchText}
            onChange={(e) => set({ matchText: e.target.value })}
            placeholder="e.g. venmo (blank = any)"
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Field label="Payment amount">
          <input className={inputBase} inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value })} placeholder="2000" />
        </Field>
        <Field label="± amount">
          <input className={inputBase} inputMode="decimal" value={f.amountTolerance} onChange={(e) => set({ amountTolerance: e.target.value })} />
        </Field>
        <Field label="Due day of month">
          <input className={inputBase} inputMode="numeric" value={f.dayOfMonth} onChange={(e) => set({ dayOfMonth: e.target.value })} />
        </Field>
        <Field label="± days">
          <input className={inputBase} inputMode="numeric" value={f.dayWindow} onChange={(e) => set({ dayWindow: e.target.value })} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Field label="People paying you back">
          <input
            className={inputBase}
            inputMode="numeric"
            value={f.reimbursementCount}
            onChange={(e) => set({ reimbursementCount: e.target.value })}
          />
        </Field>
        <Field label="Each pays">
          <input
            className={inputBase}
            inputMode="decimal"
            value={f.reimbursementAmount}
            disabled={!hasReimbursements}
            onChange={(e) => set({ reimbursementAmount: e.target.value })}
            placeholder={hasReimbursements ? "650" : "—"}
          />
        </Field>
        <Field label="± each">
          <input
            className={inputBase}
            inputMode="decimal"
            value={f.reimbursementTolerance}
            disabled={!hasReimbursements}
            onChange={(e) => set({ reimbursementTolerance: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <input type="month" className={inputBase} value={f.startMonth} onChange={(e) => set({ startMonth: e.target.value })} />
          </Field>
          <Field label="Until">
            <input type="month" className={inputBase} value={f.endMonth} onChange={(e) => set({ endMonth: e.target.value })} />
          </Field>
        </div>
      </div>

      <p className="text-xs text-ink-3">
        Each month, the outflow closest to the due day becomes the payment (spending), and inflows of
        about one share (or several shares at once) become reimbursements that net against it. Rows you
        gave a different class stay as you set them.
      </p>

      {invalid && <p className="text-xs text-neg">{invalid}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" isLoading={busy}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
        {showActive && (
          <label className="ml-auto flex items-center gap-2 text-xs text-ink-2">
            <input
              type="checkbox"
              checked={f.active}
              onChange={(e) => set({ active: e.target.checked })}
              className="size-3.5 rounded-none border-rule-strong text-ink focus:ring-ink/30"
            />
            Active (matching on)
          </label>
        )}
      </div>
    </form>
  );
}

function Terms({ ob }: { ob: Obligation }) {
  const parts = [
    `${formatMoney(ob.amount)}${Number(ob.amount_tolerance) ? ` ±${formatMoney(ob.amount_tolerance)}` : ""}`,
    `due the ${ordinal(ob.day_of_month)} ±${ob.day_window}d`,
    ob.match_text ? `“${ob.match_text}”` : "any description",
    ob.account_name ? `${ob.account_name}${ob.account_mask ? ` ··${ob.account_mask}` : ""}` : "any account",
  ];
  if (ob.reimbursement_count > 0 && ob.reimbursement_amount) {
    parts.push(
      `${ob.reimbursement_count} × ${formatMoney(ob.reimbursement_amount)}` +
        (Number(ob.reimbursement_tolerance) ? ` ±${formatMoney(ob.reimbursement_tolerance)}` : "") +
        " back",
    );
  }
  return <p className="font-mono text-[11px] text-ink-2">{parts.join(" · ")}</p>;
}

function Periods({ ob }: { ob: Obligation }) {
  if (ob.periods.length === 0) {
    return <p className="px-3 py-6 text-center text-xs text-ink-3">No months to show yet.</p>;
  }
  const hasReimbursements = ob.reimbursement_count > 0;
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-rule">
            <th className={cx(eyebrow, "px-3 py-2 text-left")}>Month</th>
            <th className={cx(eyebrow, "px-3 py-2 text-right")}>Paid</th>
            {hasReimbursements && <th className={cx(eyebrow, "px-3 py-2 text-right")}>Paid back</th>}
            {hasReimbursements && <th className={cx(eyebrow, "px-3 py-2 text-right")}>Net</th>}
            <th className={cx(eyebrow, "px-3 py-2 text-right")}>Status</th>
          </tr>
        </thead>
        <tbody>
          {ob.periods.map((p) => {
            const style = STATUS_STYLE[p.status];
            return (
              <tr key={p.period} className="border-b border-rule last:border-0">
                <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-ink">
                  {formatMonthShort(p.period)}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-xs tabular-nums text-ink">
                  {p.payment ? (
                    <>
                      {formatMoney(p.payment.amount)}
                      <span className="ml-1.5 text-ink-3">{formatDateShort(p.payment.date)}</span>
                    </>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </td>
                {hasReimbursements && (
                  <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-xs tabular-nums">
                    {p.reimbursements.length > 0 ? (
                      <span
                        className="text-pos"
                        title={p.reimbursements
                          .map((r) => `${formatDateShort(r.date)} ${formatMoney(-Number(r.amount))}${r.shares > 1 ? ` (${r.shares} shares)` : ""}`)
                          .join("\n")}
                      >
                        +{formatMoney(p.reimbursed)}
                      </span>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                    <span className="ml-1.5 text-ink-3">
                      {p.shares_received}/{ob.reimbursement_count}
                    </span>
                  </td>
                )}
                {hasReimbursements && (
                  <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-xs font-medium tabular-nums text-ink">
                    {formatMoney(p.net)}
                  </td>
                )}
                <td className="whitespace-nowrap px-3 py-1.5 text-right">
                  <span
                    className={cx(
                      "rounded-sm border px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wide",
                      style.className,
                    )}
                  >
                    {style.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function ObligationsPage() {
  const router = useRouter();
  const { refreshReview, linkVersion } = useShell();

  const [obligations, setObligations] = useState<Obligation[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Remounts the create form (clearing it) after a successful create.
  const [formKey, setFormKey] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [o, a, c] = await Promise.all([getObligations(), getAccounts(), getCategorySummary()]);
      setObligations(o.obligations);
      setAccounts(a.accounts);
      setCategories([...new Set(["RENT_AND_UTILITIES", ...c.categories.map((x) => x.category)])].sort());
    } catch (e) {
      if (e instanceof UnauthorizedError) return router.replace("/login");
      setError(e instanceof Error ? e.message : "Failed to load obligations.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load, linkVersion]);

  // Every write regroups transactions server-side; reload, and refresh the
  // review badge (grouped Venmo rows leave the queue, deleted ones return).
  async function run(action: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      refreshReview();
      after?.();
    } catch (e) {
      if (e instanceof UnauthorizedError) return router.replace("/login");
      setError(e instanceof Error ? e.message : "The change did not save.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <p className="py-24 text-center font-mono text-xs uppercase tracking-widest text-ink-3">
        Loading obligations…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="font-mono text-base font-semibold uppercase tracking-[0.14em] text-ink">
          Obligations
        </h1>
        {!creating && (
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            New obligation
          </Button>
        )}
      </div>

      {creating && (
        <Card>
          <p className={cx(eyebrow, "mb-3")}>New obligation</p>
          <ObligationForm
            key={formKey}
            initial={EMPTY_FORM}
            accounts={accounts}
            categories={categories}
            submitLabel="Create obligation"
            showActive={false}
            busy={busy}
            onSubmit={(input) =>
              void run(
                () => createObligation(input),
                () => {
                  setCreating(false);
                  setFormKey((k) => k + 1);
                },
              )
            }
            onCancel={() => setCreating(false)}
          />
        </Card>
      )}

      {error && <p className="text-sm text-neg">{error}</p>}

      {obligations.length === 0 && !creating ? (
        <Card className="py-16 text-center">
          <p className={eyebrow}>No obligations yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-2">
            Declare a recurring payment like rent, including anyone who pays you back for their share.
            Each month&apos;s payment and reimbursements are grouped automatically, so your spending shows
            what you actually pay.
          </p>
        </Card>
      ) : (
        obligations.map((ob) => {
          const editing = editId === ob.id;
          const deleting = deleteId === ob.id;
          return (
            <Card key={ob.id} className={cx("p-0", !ob.active && "opacity-70")}>
              <div className="space-y-1 border-b border-rule px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="font-mono text-sm font-semibold text-ink">{ob.name}</h2>
                  <span className="font-mono text-[10px] text-ink-3">{ob.category}</span>
                  {!ob.active && <span className={eyebrow}>paused</span>}
                  {!editing && !deleting && (
                    <div className="ml-auto flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditId(ob.id);
                          setDeleteId(null);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setDeleteId(ob.id);
                          setEditId(null);
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  )}
                </div>
                <Terms ob={ob} />
              </div>

              {deleting && (
                <div className="flex flex-wrap items-center gap-3 border-b border-rule bg-wash/50 px-3 py-2.5">
                  <p className="text-xs text-ink-2">
                    Delete <span className="font-medium text-ink">{ob.name}</span>? Its transactions go back to
                    their original class (Venmo rows return to Review). To keep past months but stop matching,
                    set an end month instead.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="danger"
                      isLoading={busy}
                      onClick={() => void run(() => deleteObligation(ob.id), () => setDeleteId(null))}
                    >
                      Delete obligation
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleteId(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {editing ? (
                <div className="bg-wash/50 px-3 py-3">
                  <ObligationForm
                    initial={toForm(ob)}
                    accounts={accounts}
                    categories={categories}
                    submitLabel="Save changes"
                    showActive
                    busy={busy}
                    onSubmit={(input) => void run(() => updateObligation(ob.id, input), () => setEditId(null))}
                    onCancel={() => setEditId(null)}
                  />
                </div>
              ) : (
                <Periods ob={ob} />
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}
