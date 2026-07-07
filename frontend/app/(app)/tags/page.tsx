"use client";

// Tags — the registry. Create (name + color from the default palette), rename,
// recolor, delete (with a usage-count warning; assignments cascade). The usage
// count links straight into the transactions table filtered by that tag.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import {
  createTag,
  deleteTag,
  getTags,
  updateTag,
  UnauthorizedError,
  type Tag,
} from "../../lib/api";
import { TAG_PALETTE } from "../../lib/classes";
import { cx, eyebrow, focusRing, inputBase } from "../../lib/utils";

function Swatches({
  value,
  onChange,
}: {
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Tag color">
      {TAG_PALETTE.map((hex) => (
        <button
          key={hex}
          type="button"
          role="radio"
          aria-checked={value === hex}
          aria-label={`color ${hex}`}
          onClick={() => onChange(hex)}
          className={cx(
            "size-5 rounded-sm border",
            value === hex ? "border-ink ring-2 ring-ink/30" : "border-rule-strong",
            ...focusRing,
          )}
          style={{ backgroundColor: hex }}
        />
      ))}
    </div>
  );
}

export default function TagsPage() {
  const router = useRouter();

  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(TAG_PALETTE[0]);
  const [creating, setCreating] = useState(false);

  // Per-row edit / delete state
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getTags();
      setTags(res.tags);
    } catch (e) {
      if (e instanceof UnauthorizedError) return router.replace("/login");
      setError(e instanceof Error ? e.message : "Failed to load tags.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      setEditId(null);
      setDeleteId(null);
    } catch (e) {
      if (e instanceof UnauthorizedError) return router.replace("/login");
      setError(e instanceof Error ? e.message : "The change did not save.");
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createTag(newName.trim(), newColor);
      setNewName("");
      // Rotate the suggested color so consecutive tags differ.
      setNewColor(TAG_PALETTE[(TAG_PALETTE.indexOf(newColor) + 1) % TAG_PALETTE.length]);
      await load();
    } catch (err) {
      if (err instanceof UnauthorizedError) return router.replace("/login");
      setError(err instanceof Error ? err.message : "Could not create the tag.");
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
    return (
      <p className="py-24 text-center font-mono text-xs uppercase tracking-widest text-ink-3">
        Loading tags…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="font-mono text-base font-semibold uppercase tracking-[0.14em] text-ink">
        Tags
      </h1>

      {/* Create */}
      <Card>
        <form onSubmit={onCreate} className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block grow sm:max-w-xs">
              <span className={eyebrow}>New tag</span>
              <input
                className={cx(inputBase, "mt-1")}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. vacation-2026"
              />
            </label>
            <Button type="submit" isLoading={creating} disabled={!newName.trim()}>
              Create tag
            </Button>
          </div>
          <Swatches value={newColor} onChange={setNewColor} />
        </form>
      </Card>

      {error && <p className="text-sm text-neg">{error}</p>}

      {/* Registry */}
      {tags.length === 0 ? (
        <Card className="py-16 text-center">
          <p className={eyebrow}>No tags yet</p>
          <p className="mt-2 text-sm text-ink-2">
            Tags cut across categories — trips, projects, reimbursables. Create
            one above, then attach it from any transaction row.
          </p>
        </Card>
      ) : (
        <Card className="p-0">
          {tags.map((t) => {
            const editing = editId === t.id;
            const deleting = deleteId === t.id;
            return (
              <div key={t.id} className="border-b border-rule px-3 py-2 last:border-0">
                {editing ? (
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        aria-label="Tag name"
                        className={cx(inputBase, "w-56")}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                      />
                      <Button
                        size="sm"
                        isLoading={busy}
                        disabled={!editName.trim()}
                        onClick={() =>
                          void run(() =>
                            updateTag(t.id, { name: editName.trim(), color: editColor }),
                          )
                        }
                      >
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditId(null)}>
                        Cancel
                      </Button>
                    </div>
                    <Swatches value={editColor} onChange={setEditColor} />
                  </div>
                ) : deleting ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-xs text-ink-2">
                      Delete <span className="font-medium text-ink">{t.name}</span>?
                      {t.txn_count > 0
                        ? ` It will be removed from ${t.txn_count} transaction${t.txn_count === 1 ? "" : "s"}.`
                        : " It isn't attached to any transactions."}
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="danger" isLoading={busy} onClick={() => void run(() => deleteTag(t.id))}>
                        Delete tag
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleteId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="size-3 shrink-0 rounded-sm border border-rule-strong"
                      style={{ backgroundColor: t.color || "#716d60" }}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{t.name}</span>
                    <Link
                      href={`/transactions?tag=${t.id}`}
                      className={cx(
                        "whitespace-nowrap font-mono text-[10px] uppercase tracking-wide text-ink-2 underline hover:text-ink",
                        ...focusRing,
                      )}
                    >
                      {t.txn_count} txn{t.txn_count === 1 ? "" : "s"}
                    </Link>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditId(t.id);
                        setEditName(t.name);
                        setEditColor(t.color || TAG_PALETTE[0]);
                        setDeleteId(null);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setDeleteId(t.id);
                        setEditId(null);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
