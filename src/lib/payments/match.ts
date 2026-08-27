import type {PaymentChainKey} from "@/lib/chains";
import type {PaymentToken} from "@/lib/models/Payment";

/** One observed on-chain transfer, already decoded to a chain-agnostic shape - an ERC-20
 * `Transfer` log or a native-asset transaction, normalized by the caller before this function ever
 * sees it. `tokenAddress` is `undefined` for a native transfer, matching `OpenRail.tokenAddress`'s
 * same convention so equality comparison needs no special-casing. */
export interface ObservedTransfer {
  to: string;
  tokenAddress?: string;
  amountBase: string;
  blockNumber: number;
  txHash: string;
  from: string;
}

/** One open payment's crypto rail, reduced to just what matching needs. */
export interface OpenRail {
  paymentId: string;
  chainKey: PaymentChainKey;
  token: PaymentToken;
  tokenAddress?: string;
  receivingAddress: string;
  amountBase: string;
}

export interface PaymentMatch {
  paymentId: string;
  chainKey: PaymentChainKey;
  token: PaymentToken;
  transfer: ObservedTransfer;
  confirmations: number;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The exact `(to, token, amountBase)` matcher wp4-vet.md's watcher section specifies, WITH the
 * confirmation-depth gate applied inline - this is deliberately the single function both the
 * production watcher and the unit tests call, so a passing test is proof the production code path
 * enforces confirmations, not a parallel check the watcher could bypass. `currentBlock` is the
 * chain tip the caller observed when it fetched `transfers`; a transfer included in the current tip
 * block itself has 1 confirmation, per `currentBlock - blockNumber + 1`.
 *
 * A wrong-amount transfer to the right address (or a right-amount transfer to an unrelated
 * address, or the right pair on the wrong token) is silently ignored - there is no "close enough"
 * fallback, by design: `amountBase`'s dust suffix exists precisely so only an exact match is ever
 * meaningful.
 */
export function matchTransfers(
  transfers: ObservedTransfer[],
  openRails: OpenRail[],
  currentBlock: number,
  requiredConfirmations: number,
): PaymentMatch[] {
  const matches: PaymentMatch[] = [];

  for (const transfer of transfers) {
    const confirmations = currentBlock - transfer.blockNumber + 1;
    if (confirmations < requiredConfirmations) continue;

    const rail = openRails.find(
      (r) =>
        sameAddress(r.receivingAddress, transfer.to) &&
        r.amountBase === transfer.amountBase &&
        ((r.tokenAddress === undefined && transfer.tokenAddress === undefined) ||
          (r.tokenAddress !== undefined &&
            transfer.tokenAddress !== undefined &&
            sameAddress(r.tokenAddress, transfer.tokenAddress))),
    );
    if (!rail) continue;

    matches.push({paymentId: rail.paymentId, chainKey: rail.chainKey, token: rail.token, transfer, confirmations});
  }

  return matches;
}
