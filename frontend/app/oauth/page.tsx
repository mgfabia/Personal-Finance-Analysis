"use client";

// OAuth return leg of Plaid Link (Production; most major US banks).
//
// Mid-Link, an OAuth bank sends the browser to its own site to authenticate,
// then redirects back here (this page's URL is PLAID_REDIRECT_URI, registered
// in the Plaid dashboard). Link must be re-initialized with the SAME
// link_token the flow started with (stored in localStorage by LinkButton)
// plus receivedRedirectUri, so it can resume where it left off. From
// onSuccess onward the flow is identical to LinkButton: exchange the
// public_token backend-side, then land on the dashboard.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePlaidLink } from "react-plaid-link";

import {
  clearStoredLinkToken,
  exchangePublicToken,
  getStoredLinkToken,
  isAuthenticated,
  UnauthorizedError,
} from "../lib/api";

export default function OAuthReturnPage() {
  const router = useRouter();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
      return;
    }
    const stored = getStoredLinkToken();
    if (!stored) {
      // Direct visit or a stale redirect — nothing to resume.
      router.replace("/");
      return;
    }
    setLinkToken(stored);
  }, [router]);

  const onSuccess = useCallback(
    async (publicToken: string) => {
      try {
        await exchangePublicToken(publicToken);
        router.replace("/");
      } catch (e) {
        if (e instanceof UnauthorizedError) return router.replace("/login");
        setError(e instanceof Error ? e.message : "Failed to link account.");
      } finally {
        clearStoredLinkToken();
      }
    },
    [router],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    // Hands Link the bank's OAuth callback params (oauth_state_id) so it
    // resumes instead of starting over.
    receivedRedirectUri:
      typeof window !== "undefined" ? window.location.href : undefined,
    onSuccess,
    onExit: () => {
      clearStoredLinkToken();
      router.replace("/");
    },
  });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      {error ? (
        <div className="text-center">
          <p className="text-sm text-red-600">{error}</p>
          <button
            className="mt-2 text-sm underline"
            onClick={() => router.replace("/")}
          >
            Back to dashboard
          </button>
        </div>
      ) : (
        <p className="text-sm text-gray-500">Finishing bank connection…</p>
      )}
    </main>
  );
}
