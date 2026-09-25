"use client";

import {Banner} from "@/components/ui/Banner";
import {RequestTopUpButton} from "@/components/wallet/RequestTopUpButton";

/** WP4.19 V3 - the shared "refused to send" banner every issue/revoke/reactivate call site renders
 * when `useGasPreflight`'s `ensure` returns `false`. `walletAddress` is the wallet the top-up
 * request should name - the one that was actually about to sign, not necessarily the currently
 * "recorded" one. */
export function GasPreflightBanner({message, walletAddress}: {message: string; walletAddress?: string}) {
  return (
    <Banner tone="danger" title="Not enough PLASMA for this transaction">
      <p className="mb-2">{message}</p>
      <RequestTopUpButton walletAddress={walletAddress} />
    </Banner>
  );
}
