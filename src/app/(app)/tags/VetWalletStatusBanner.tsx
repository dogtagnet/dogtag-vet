"use client";

import {useAccount} from "wagmi";
import {Banner} from "@/components/ui/Banner";
import {IssuanceWalletBalanceLine} from "@/components/wallet/IssuanceWalletBalanceLine";
import {truncateMiddle} from "@/lib/format";
import {decideVetWalletBanner, operatorStatusExplanation, type OperatorStatus} from "@/lib/staffRoleTone";

/**
 * WP4.7C item 3(b) - shared between `/tags` and `/tags/issue` (both server components; each
 * fetches `status`/`recordedAddress` via `resolveOperatorStatus` and renders this once, right
 * below its `PageHeader`). A PERSISTENT warning - `Banner`'s own `dismissKey` is deliberately
 * omitted, unlike the neighboring "Issuer domain not configured" banner on `/tags/issue`, which
 * IS dismissible - a vet/owner who cannot actually issue should never be able to permanently
 * silence the one signal telling them so.
 *
 * Extends, never duplicates, `TagIssueWizard`'s existing "Connect your operator wallet" banner
 * (~line 420, only rendered while `!isConnected`): that one is about the CONNECTION itself and
 * stays completely untouched; this one is about the RECORDED address's on-chain status, and about
 * a connected-but-different wallet - both can legitimately be visible at once with no overlap in
 * what they each say.
 *
 * The actual show/hide + which-facts-to-show decision is `decideVetWalletBanner` (staffRoleTone.ts)
 * - a pure function, unit-tested directly, since this repo has no component-rendering test
 * harness. This component is a thin wrapper feeding it `useAccount()`'s live values.
 */
export function VetWalletStatusBanner({status, recordedAddress}: {status: OperatorStatus; recordedAddress?: string}) {
  const {address: connectedAddress, isConnected} = useAccount();
  const decision = decideVetWalletBanner({status, recordedAddress, connectedAddress, isConnected});

  return (
    <>
      {decision.show && (
        <div className="mb-6">
          <Banner tone="warn" title="Check your issuance access">
            {decision.showStatusIssue && <p>{operatorStatusExplanation(status)}</p>}
            {decision.showMismatch && (
              <p className={decision.showStatusIssue ? "mt-2" : undefined}>
                Your connected wallet ({truncateMiddle(connectedAddress!)}) is different from your recorded address (
                {truncateMiddle(recordedAddress!)}) - issuing uses whichever wallet is actually connected, not the
                recorded one.
              </p>
            )}
          </Banner>
        </div>
      )}
      {/* WP4.19 V1 - independent of the whitelist-status banner above (a correctly whitelisted
          wallet can still be low on gas, and the reverse), so this renders whenever a wallet is
          connected, whether or not the block above does - `IssuanceWalletBalanceLine` itself
          renders nothing when no wallet is connected. */}
      <div className="mb-6">
        <IssuanceWalletBalanceLine />
      </div>
    </>
  );
}
