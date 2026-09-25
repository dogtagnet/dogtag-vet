"use client";

import {useCallback, useEffect, useState} from "react";
import {parseUnits} from "viem";
import {useAccount, usePublicClient} from "wagmi";
import {formatTokenAmount} from "@/lib/format";
import {usePublicEnv} from "@/lib/usePublicEnv";

/** How often the balance is re-read while a page with this hook stays open - PLASMA balance only
 * changes from an admin top-up or this clinic's own writes, neither of which this app is pushed a
 * notification about (the same "no live event feed" tradeoff `issuanceOperatorStatus.ts`'s own
 * cache doc comment names for whitelist status), so a light poll is enough - no need for the 2s
 * cadence a mint-session poll uses. */
const POLL_MS = 15_000;

export interface IssuanceWalletBalance {
  address?: `0x${string}`;
  /** `undefined` while never yet read (no connected wallet, or the first read has not resolved) -
   * distinct from `0n`, a genuinely empty wallet. */
  balanceWei?: bigint;
  /** `balanceWei` formatted as a plain PLASMA decimal string (18 decimals, exact - never rounded,
   * `format.ts`'s existing `formatTokenAmount`), or `undefined` while `balanceWei` is. */
  balanceDisplay?: string;
  /** `true` once a successful read has landed and it is below `OPERATOR_LOW_PLASMA` (the vet
   * runtime public config - `usePublicEnv().operatorLowPlasma`). Always `false` while
   * `balanceWei` is `undefined` - an unread balance is never treated as low. */
  low: boolean;
  loading: boolean;
  /** Re-reads the balance immediately, outside the poll cadence - callers use this right after a
   * write confirms (the balance just changed: gas was spent, and refunded or not) so the card does
   * not wait up to `POLL_MS` to reflect it. */
  refetch: () => void;
}

/**
 * WP4.19 V1 - the CONNECTED operator wallet's live PLASMA balance, read straight from the public
 * client (`publicClient.getBalance`), shared between the "My issuance wallet" card
 * (`MyWalletSection.tsx`) and the /tags + /tags/issue + /pets wallet banner
 * (`VetWalletStatusBanner.tsx`) so the two surfaces can never show a different number for the
 * identical wallet - the same "one shared answer" principle `issuanceOperatorStatus.ts`'s own doc
 * comment states for whitelist status, just client-side (a balance is not something a server
 * component can read once and hand down - it should stay live while the tab is open).
 */
export function useIssuanceWalletBalance(): IssuanceWalletBalance {
  const {address, isConnected} = useAccount();
  const publicClient = usePublicClient();
  const {operatorLowPlasma} = usePublicEnv();

  const [balanceWei, setBalanceWei] = useState<bigint | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [generation, setGeneration] = useState(0);

  const refetch = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    if (!isConnected || !address || !publicClient) {
      setBalanceWei(undefined);
      return;
    }
    let cancelled = false;
    async function read() {
      setLoading(true);
      try {
        const wei = await publicClient!.getBalance({address: address!});
        if (!cancelled) setBalanceWei(wei);
      } catch {
        // Fail closed to "unread", never a stale/guessed number - the card/banner render their own
        // "-" or omit the low-warning while balanceWei stays undefined.
        if (!cancelled) setBalanceWei(undefined);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    read();
    const interval = setInterval(read, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [address, isConnected, publicClient, generation]);

  const lowThresholdWei = parseUnits(operatorLowPlasma.toString(), 18);
  const low = balanceWei !== undefined && balanceWei < lowThresholdWei;

  return {
    address,
    balanceWei,
    balanceDisplay: balanceWei !== undefined ? formatTokenAmount(balanceWei.toString(), 18) : undefined,
    low,
    loading,
    refetch,
  };
}
