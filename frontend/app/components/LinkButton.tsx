"use client";

// Add-a-bank via Plaid Link — Phase 8 (drives the Phase 2 endpoints).
//
// Flow (invariant 1 holds — the browser never sees the secret/access_token):
//   1. POST /link/token/create → short-lived link_token
//   2. open Plaid Link with it; the user authenticates with their bank
//   3. onSuccess hands back a public_token → POST /item/public_token/exchange
//      (the backend swaps it for an access_token, stores it encrypted, reconciles
//      accounts). We only learn the item was linked.

import { RiAddLine } from "@remixicon/react";
import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";

import { Button } from "./ui/Button";
import { createLinkToken, exchangePublicToken } from "../lib/api";

export default function LinkButton({ onLinked }: { onLinked: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSuccess = useCallback(
    async (publicToken: string) => {
      setBusy(true);
      try {
        await exchangePublicToken(publicToken);
        onLinked();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to link account.");
      } finally {
        setBusy(false);
        setToken(null);
      }
    },
    [onLinked],
  );

  const { open, ready } = usePlaidLink({ token: token ?? "", onSuccess });

  useEffect(() => {
    if (token && ready) {
      open();
      setBusy(false);
    }
  }, [token, ready, open]);

  async function start() {
    setError(null);
    setBusy(true);
    try {
      const { link_token } = await createLinkToken();
      setToken(link_token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start Plaid Link.");
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-sm text-red-600">{error}</span>}
      <Button onClick={start} isLoading={busy}>
        {!busy && <RiAddLine className="size-4" />}
        Add bank
      </Button>
    </div>
  );
}
