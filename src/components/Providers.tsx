"use client";

import {useEffect, useRef, useState, type ReactNode} from "react";
import {usePathname} from "next/navigation";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {WagmiProvider, useAccount, useConnect} from "wagmi";
import {wagmiConfig} from "@/lib/wagmi";
import {publicEnv} from "@/lib/env.public";
import {SnackbarProvider} from "@/components/ui/Snackbar";

/** The only routes anything reads `useAccount()`/`useConnect()` at all
 * (`TagIssueWizard`/`TagsTable` under `/tags`, `VerifySessionPanel` under `/verify`,
 * `SetupWizard` under `/setup`, `MyWalletSection`'s "Use connected wallet" button under
 * `/settings`) - see `E2EMockWalletAutoConnect`'s own doc comment on why the auto-connect effect
 * is scoped to exactly these instead of running on every page. WP4.16: `/settings`'s OTHER wallet
 * surface, `OperatorsSection`, reads on-chain operator status with a bare `useReadContract` and
 * has needed no connected account of its own since that wave removed its Add/Remove write - it
 * stays off this list on its own merits, not merely left out. */
function isWalletGatedPath(pathname: string): boolean {
  return pathname === "/setup" || pathname === "/verify" || pathname === "/settings" || pathname.startsWith("/tags");
}

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
 * Scoped to `isWalletGatedPath` rather than firing on every page: the connector list itself must
 * stay global (wagmi has no per-route config), but the CONNECT ATTEMPT - a real browser-side
 * `eth_requestAccounts`/`eth_chainId` round trip to the RPC stub - has no reason to run on, say,
 * `/calendar` or `/clients`, which never read wagmi state at all. Diagnosed empirically while
 * validating this track: running the whole gate unconditionally measurably destabilized an
 * unrelated spec's timing (extra async work on every navigation, suite-wide) with no behavioral
 * upside on pages that never look at `isConnected`.
 *
 * `attempted` (not just the `isConnected`/`status` checks alone) makes this a ONE-SHOT attempt per
 * mount: `status` flipping to `"error"` while `isConnected` stays false would otherwise re-run the
 * effect (its own dependencies changed) and retry forever.
 */
function E2EMockWalletAutoConnect() {
  const pathname = usePathname();
  const {isConnected} = useAccount();
  const {connect, connectors, status} = useConnect();
  const attempted = useRef(false);

  useEffect(() => {
    if (!isWalletGatedPath(pathname) || isConnected || attempted.current || status === "pending") return;
    const mockConnector = connectors.find((c) => c.id === "mock");
    if (!mockConnector) return;
    attempted.current = true;
    connect({connector: mockConnector});
  }, [pathname, isConnected, status, connect, connectors]);

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
