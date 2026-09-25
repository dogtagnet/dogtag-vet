"use client";

import {useIssuanceWalletBalance} from "@/lib/useIssuanceWalletBalance";
import {RequestTopUpButton} from "@/components/wallet/RequestTopUpButton";

/**
 * WP4.19 V1 - the connected operator wallet's live PLASMA balance plus the low-balance warning,
 * shared verbatim between the "My issuance wallet" card (`MyWalletSection.tsx`) and the /tags +
 * /tags/issue + /pets wallet banner (`VetWalletStatusBanner.tsx`) - same "one shared answer, never
 * two surfaces disagreeing" principle `decideVetWalletBanner`/`operatorStatusExplanation` already
 * follow for whitelist status (`staffRoleTone.ts`'s own doc comments), now for balance too.
 *
 * Renders nothing at all when no wallet is connected - `useIssuanceWalletBalance` has nothing to
 * show in that case, and both callers already have their own "connect a wallet" messaging that
 * this must not duplicate or contradict.
 */
export function IssuanceWalletBalanceLine() {
  const {address, balanceDisplay, low, loading} = useIssuanceWalletBalance();

  if (!address) return null;

  return (
    <div className="space-y-1.5" data-testid="issuance-wallet-balance">
      <p className="text-body text-ink">
        Wallet balance:{" "}
        <span className="font-mono">
          {balanceDisplay !== undefined ? `${balanceDisplay} PLASMA` : loading ? "Checking..." : "Could not read"}
        </span>
      </p>
      {low && (
        <>
          <p className="text-caption text-warn" data-testid="low-balance-warning">
            This wallet is low on PLASMA - issuance transactions may fail. Ask your admin for a top-up.
          </p>
          <RequestTopUpButton walletAddress={address} />
        </>
      )}
    </div>
  );
}
