"use client";

import {useEffect, useRef, useState, type ReactNode} from "react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {WagmiProvider, useAccount, useConnect} from "wagmi";
import {wagmiConfig} from "@/lib/wagmi";
import {publicEnv} from "@/lib/env.public";
import {SnackbarProvider} from "@/components/ui/Snackbar";

/**
 * DEV/TEST ONLY - see `wagmi.ts`'s own doc comment on the same `NEXT_PUBLIC_E2E_MOCK_WALLET_ADDRESS`
 * gate this mirrors. Auto-connects the env-gated `mock` connector on mount so Playwright never has
 * to click a real "Connect" button. This is needed BECAUSE the mock connector's own `isAuthorized`
 * (the thing wagmi's built-in reconnect-on-mount consults) has nothing to restore on a fresh mount
 * - unlike a real wallet extension, there was never a genuine prior connection for it to remember -
 * so without an explicit connect attempt here, every page load (a real `page.reload()` included)
 * would start disconnected even with the gate on, which defeats the entire point of wiring this
 * connector in: `TagIssueWizard`/`TagsTable`/`VerifySessionPanel`/`SetupWizard` all render nothing
 * past a "connect your wallet" gate until `useAccount().isConnected`.
 *
 * `attempted` (not just the `isConnected`/`status` checks alone) makes this a ONE-SHOT attempt per
 * mount: `status` flipping to `"error"` while `isConnected` stays false would otherwise re-run the
 * effect (its own dependencies changed) and retry forever.
 */
function E2EMockWalletAutoConnect() {
  const {isConnected} = useAccount();
  const {connect, connectors, status} = useConnect();
  const attempted = useRef(false);

  useEffect(() => {
    if (isConnected || attempted.current || status === "pending") return;
    const mockConnector = connectors.find((c) => c.id === "mock");
    if (!mockConnector) return;
    attempted.current = true;
    connect({connector: mockConnector});
  }, [isConnected, status, connect, connectors]);

  return null;
}

/** Client-side provider tree: wagmi (wallet/chain state) + TanStack Query (wagmi's own
 * requirement, also used for our own data fetching) + the Snackbar host. Mounted once in the root
 * layout so any client component anywhere can use wagmi hooks or useSnackbar(). */
export function Providers({children}: {children: ReactNode}) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <SnackbarProvider>
          {/* DEV/TEST ONLY - see `E2EMockWalletAutoConnect`'s own doc comment. Not rendered at all
           * (not merely a no-op) unless NEXT_PUBLIC_E2E_MOCK_WALLET_ADDRESS is set, so production's
           * render tree is exactly what it was before this gate existed. */}
          {publicEnv.e2eMockWalletAddress && <E2EMockWalletAutoConnect />}
          {children}
        </SnackbarProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
