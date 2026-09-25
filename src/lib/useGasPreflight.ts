"use client";

import {useState} from "react";
import type {PublicClient} from "viem";
import {gasFloorFor} from "@/lib/chainWrite";
import {checkGasPreflight, gasPreflightMessage} from "@/lib/gasPreflight";

export interface GasPreflightBlock {
  message: string;
}

export interface GasPreflight {
  /** Set (with the message to show) after `ensure` refuses a write; `null` otherwise - render a
   * banner plus `RequestTopUpButton` when this is set, next to the action that was refused. */
  block: GasPreflightBlock | null;
  clearBlock: () => void;
  /**
   * WP4.19 V3 - issue/revoke/reactivate all call this immediately before building their
   * `legacyTxWithGas` transaction. Reads the wallet's LIVE balance and the chain's LIVE gas price
   * (never a cached/polled value - `useIssuanceWalletBalance`'s own display is deliberately NOT
   * reused here for that reason) and refuses when `balance < gasFloor(functionName) * gasPrice` -
   * the exact same floor `legacyTxWithGas` itself would apply (`chainWrite.ts`'s `gasFloorFor`,
   * never a second copy of that fallback table), so this can never wave through a wallet
   * `legacyTxWithGas` would then still size a floor-sized transaction for.
   *
   * Fails OPEN (returns `true`, no block) when there is no connected wallet/public client yet, or
   * when the balance/gas-price reads themselves fail - this is a courtesy pre-flight warning, not
   * the safety mechanism (that is `legacyTxWithGas`'s own never-fails-open floor, unconditionally
   * applied regardless of whether this check ever ran); a transient RPC hiccup on THIS check must
   * never become a NEW way to block an issuance that would otherwise have gone through fine, since
   * the wallet's own send will simply fail on its own if funds truly are not there.
   */
  ensure: (publicClient: PublicClient | undefined, address: `0x${string}` | undefined, functionName: string) => Promise<boolean>;
}

export function useGasPreflight(): GasPreflight {
  const [block, setBlock] = useState<GasPreflightBlock | null>(null);

  async function ensure(publicClient: PublicClient | undefined, address: `0x${string}` | undefined, functionName: string): Promise<boolean> {
    setBlock(null);
    if (!publicClient || !address) return true;
    try {
      const [balance, gasPrice] = await Promise.all([publicClient.getBalance({address}), publicClient.getGasPrice()]);
      const result = checkGasPreflight(balance, gasPrice, gasFloorFor(functionName));
      if (!result.ok) {
        setBlock({message: gasPreflightMessage(result.neededWei)});
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  return {block, clearBlock: () => setBlock(null), ensure};
}
