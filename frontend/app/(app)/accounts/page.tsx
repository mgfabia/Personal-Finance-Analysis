"use client";

// Accounts — the registry. One card per institution; each row shows the
// effective name (user display_name over the bank's name), mask, type, and
// balance. Rename inline; "Reset to bank name" clears the override (null —
// the views fall back to Plaid's name). First page in the app to render
// balances.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { useShell } from "../../components/AppShell";
import {
  getAccounts,
  updateAccount,
  UnauthorizedError,
  type Account,
} from "../../lib/api";
import { formatMoney } from "../../lib/format";
import { cx, eyebrow, inputBase } from "../../lib/utils";

function accountLabel(a: Account): string {
  return a.display_name ?? a.name ?? "Account";
}

function typeLine(a: Account): string {
  return [a.type, a.subtype].filter(Boolean).join(" · ");
}

export default function AccountsPage() {
  const router = useRouter();
  const { linkVersion } = useShell();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-row edit state
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getAccounts();
      setAccounts(res.accounts);
    } catch (e) {
      if (e instanceof UnauthorizedError) return router.replace("/login");
      setError(e instanceof Error ? e.message : "Failed to load accounts.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load, linkVersion]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      setEditId(null);
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
        Loading accounts…
      </p>
    );
  }

  // Group by institution, preserving the API's (type, name) ordering.
  const groups = new Map<string, Account[]>();
  for (const a of accounts) {
    const key = a.institution_name ?? "Unknown institution";
    const list = groups.get(key);
    if (list) list.push(a);
    else groups.set(key, [a]);
  }

  return (
    <div className="space-y-4">
      <h1 className="font-mono text-base font-semibold uppercase tracking-[0.14em] text-ink">
        Accounts
      </h1>

      {error && <p className="text-sm text-neg">{error}</p>}

      {accounts.length === 0 ? (
        <Card className="py-16 text-center">
          <p className={eyebrow}>No accounts yet</p>
          <p className="mt-2 text-sm text-ink-2">
            Link a bank with the button in the sidebar and its accounts will
            appear here.
          </p>
        </Card>
      ) : (
        [...groups.entries()].map(([institution, list]) => (
          <Card key={institution} className="p-0">
            <p className={cx(eyebrow, "border-b border-rule px-3 py-2")}>{institution}</p>
            {list.map((a) => {
              const editing = editId === a.id;
              return (
                <div key={a.id} className="border-b border-rule px-3 py-2 last:border-0">
                  {editing ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        aria-label="Account display name"
                        className={cx(inputBase, "w-56")}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder={a.name ?? "Account name"}
                      />
                      <Button
                        size="sm"
                        isLoading={busy}
                        disabled={!editName.trim()}
                        onClick={() =>
                          void run(() =>
                            updateAccount(a.id, { display_name: editName.trim() }),
                          )
                        }
                      >
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditId(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs text-ink">
                          {accountLabel(a)}
                          {a.mask && <span className="text-ink-3"> ··{a.mask}</span>}
                        </p>
                        <p className="truncate text-[11px] text-ink-2">
                          {typeLine(a)}
                          {a.display_name && a.name && (
                            <span> · Bank name: {a.name}</span>
                          )}
                        </p>
                      </div>
                      <span className="font-mono text-xs tabular-nums text-ink">
                        {a.current_balance !== null
                          ? formatMoney(a.current_balance, a.currency)
                          : "—"}
                      </span>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditId(a.id);
                            setEditName(a.display_name ?? a.name ?? "");
                          }}
                        >
                          Rename
                        </Button>
                        {a.display_name && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void run(() => updateAccount(a.id, { display_name: null }))
                            }
                          >
                            Reset to bank name
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        ))
      )}
    </div>
  );
}
