"use client";

// Authed section layout: guard (localStorage JWT → bounce to /login) + the
// shared shell. /login and /oauth live outside this group and stay bare.

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { AppShell } from "../components/AppShell";
import { isAuthenticated } from "../lib/api";

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
      return;
    }
    setReady(true);
  }, [router]);

  if (!ready) return null;
  return <AppShell>{children}</AppShell>;
}
