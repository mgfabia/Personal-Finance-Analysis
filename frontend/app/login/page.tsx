"use client";

// Sign-in — hand-rolled: POST /auth/login, store the returned JWT, redirect to
// the ledger. The backend returns an identical 401 for unknown-email and
// wrong-password, so we show one generic message.

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { isAuthenticated, login } from "../lib/api";
import { cx, eyebrow, inputBase } from "../lib/utils";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isAuthenticated()) router.replace("/");
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <p className="font-mono text-sm font-semibold uppercase tracking-[0.18em] text-ink">
          The Ledger
        </p>
        <p className={cx(eyebrow, "mt-1")}>Sign in to open the books</p>

        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <div>
            <label htmlFor="email" className={eyebrow}>
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className={cx(inputBase, "mt-1")}
            />
          </div>

          <div>
            <label htmlFor="password" className={eyebrow}>
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className={cx(inputBase, "mt-1")}
            />
          </div>

          {error && <p className="text-sm text-neg">{error}</p>}

          <Button type="submit" isLoading={submitting} className="w-full">
            Sign in
          </Button>
        </form>
      </Card>
    </main>
  );
}
