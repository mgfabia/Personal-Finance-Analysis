"use client";

// The Ledger's app shell: a compact ink-on-paper sidebar (top bar on mobile),
// the nav's live review-count badge, and a small context the pages share for
// refreshing that badge and reacting to a newly linked bank.

import {
  RiArrowLeftRightLine,
  RiBookletLine,
  RiInboxLine,
  RiListUnordered,
  RiLogoutBoxRLine,
  RiPriceTag3Line,
  RiBankLine
} from "@remixicon/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { clearToken, getReview, UnauthorizedError } from "../lib/api";
import { cx, eyebrow, focusRing } from "../lib/utils";
import LinkButton from "./LinkButton";

interface ShellState {
  /** Live size of the review queue (null until first load). */
  reviewCount: number | null;
  /** Re-fetch the badge — call after any action that can change the queue. */
  refreshReview: () => void;
  /** Bumped when a bank is linked; pages include it in effect deps to refetch. */
  linkVersion: number;
}

const ShellContext = createContext<ShellState>({
  reviewCount: null,
  refreshReview: () => {},
  linkVersion: 0,
});

export function useShell(): ShellState {
  return useContext(ShellContext);
}

const NAV = [
  { href: "/", label: "Overview", icon: RiBookletLine },
  { href: "/accounts", label: "Accounts", icon: RiBankLine },
  { href: "/transactions", label: "Transactions", icon: RiListUnordered },
  { href: "/transfers", label: "Transfers", icon: RiArrowLeftRightLine },
  { href: "/review", label: "Review", icon: RiInboxLine },
  { href: "/tags", label: "Tags", icon: RiPriceTag3Line },
] as const;

function NavLink({
  href,
  label,
  icon: Icon,
  badge,
  compact,
}: {
  href: string;
  label: string;
  icon: typeof RiInboxLine;
  badge?: number | null;
  compact?: boolean;
}) {
  const pathname = usePathname();
  const active = pathname === href;
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cx(
        "flex items-center gap-2 rounded-sm px-2.5 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.1em] transition-colors",
        active ? "bg-wash text-ink" : "text-ink-2 hover:bg-wash hover:text-ink",
        compact && "shrink-0",
        ...focusRing,
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span>{label}</span>
      {badge != null && badge > 0 && (
        <span className="ml-auto rounded-sm bg-ink px-1.5 py-px font-mono text-[10px] font-semibold text-paper">
          {badge}
        </span>
      )}
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [linkVersion, setLinkVersion] = useState(0);

  const refreshReview = useCallback(() => {
    getReview()
      .then((r) => setReviewCount(r.count))
      .catch((e) => {
        if (e instanceof UnauthorizedError) router.replace("/login");
        // Badge failures are non-fatal; leave the last known count.
      });
  }, [router]);

  useEffect(() => {
    refreshReview();
  }, [refreshReview, linkVersion]);

  const onLinked = useCallback(() => {
    setLinkVersion((v) => v + 1);
  }, []);

  function signOut() {
    clearToken();
    router.replace("/login");
  }

  const nav = NAV.map((n) => (
    <NavLink
      key={n.href}
      href={n.href}
      label={n.label}
      icon={n.icon}
      badge={n.href === "/review" ? reviewCount : undefined}
    />
  ));

  return (
    <ShellContext.Provider value={{ reviewCount, refreshReview, linkVersion }}>
      <div className="min-h-dvh">
        {/* Desktop sidebar */}
        <aside className="fixed inset-y-0 left-0 z-20 hidden w-52 flex-col border-r border-rule bg-paper md:flex">
          <div className="border-b border-rule px-4 py-4">
            <p className="font-mono text-sm font-semibold uppercase tracking-[0.18em] text-ink">
              The Ledger
            </p>
            <p className={cx(eyebrow, "mt-0.5")}>Personal finance</p>
          </div>
          <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 p-2.5">
            {nav}
          </nav>
          <div className="space-y-2 border-t border-rule p-2.5">
            <LinkButton onLinked={onLinked} />
            <button
              onClick={signOut}
              className={cx(
                "flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-ink-2 hover:bg-wash hover:text-ink",
                ...focusRing,
              )}
            >
              <RiLogoutBoxRLine className="size-4" aria-hidden="true" />
              Sign out
            </button>
          </div>
        </aside>

        {/* Mobile top bar */}
        <header className="sticky top-0 z-20 border-b border-rule bg-paper md:hidden">
          <div className="flex items-center justify-between gap-2 px-3 pt-3">
            <p className="font-mono text-sm font-semibold uppercase tracking-[0.18em] text-ink">
              The Ledger
            </p>
            <button
              onClick={signOut}
              aria-label="Sign out"
              className={cx("rounded-sm p-1.5 text-ink-2 hover:bg-wash", ...focusRing)}
            >
              <RiLogoutBoxRLine className="size-4" aria-hidden="true" />
            </button>
          </div>
          <nav aria-label="Main" className="flex gap-0.5 overflow-x-auto px-2 py-2">
            {NAV.map((n) => (
              <NavLink
                key={n.href}
                href={n.href}
                label={n.label}
                icon={n.icon}
                badge={n.href === "/review" ? reviewCount : undefined}
                compact
              />
            ))}
          </nav>
        </header>

        <main className="px-3 py-4 sm:px-5 sm:py-6 md:ml-52">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </ShellContext.Provider>
  );
}
