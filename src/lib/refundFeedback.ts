import {decodeEventLog} from "viem";
import type {Log} from "viem";
import {vetIssuerAbi} from "@/lib/abi";

/**
 * WP4.19 V2 - after every clone write that confirms (`issueTag`/`revokeTag`/`reactivateTag`/
 * `issueRecord`/`revokeRecord`/`addSecondaryOwner`/`revokeSecondaryOwner`), tell the vet whether
 * the clinic's clone actually refunded the gas their wallet fronted for it.
 *
 * The plan draft that opened this wave named the event to look for as "`GasRefunded` or
 * `RefundSkipped(address,uint256)`" and asked this file to confirm the exact name(s) against the
 * vendored ABI before wiring anything up. Confirmed directly against
 * `protocol/contracts/exports/abi/VetIssuer.json` (every `type: "event"` entry checked by name) and
 * against the modifier's own Solidity source (`protocol/contracts/flattened/VetIssuer.sol`,
 * `modifier refundsGas`): there is NO `GasRefunded` event anywhere in this protocol snapshot. A
 * SUCCESSFUL refund is a bare native `.call{value: amount}("")` with no event of its own - the
 * modifier only ever emits `RefundSkipped(address indexed operator, uint256 wanted)`, and only on
 * the two paths where it could NOT pay: the clone's own balance is below the wanted amount, or the
 * native transfer itself reverts/fails. So "refunded" is read here as the ABSENCE of a
 * `RefundSkipped` log from the clone on this receipt, never the presence of a positive event -
 * there is nothing positive to look for.
 */
export type RefundOutcome = "refunded" | "skipped";

/** `logs` is the mined receipt's own `logs` (`useWaitForTransactionReceipt`'s `data.logs` - no
 * extra chain read needed, the wallet's own receipt already carries them). `cloneAddress` scopes
 * the check to logs actually emitted BY the clinic's own clone on this tx - a `RefundSkipped` from
 * some unrelated contract in the same block would never appear in a single transaction's own
 * receipt anyway, but matching the address explicitly costs nothing and keeps this function honest
 * about what it is actually checking. */
export function decodeRefundOutcome(logs: readonly Log[], cloneAddress: string): RefundOutcome {
  const normalizedClone = cloneAddress.toLowerCase();
  const skipped = logs.some((log) => {
    if (typeof log.address !== "string" || log.address.toLowerCase() !== normalizedClone) return false;
    try {
      const decoded = decodeEventLog({
        abi: vetIssuerAbi,
        data: log.data,
        topics: log.topics,
        eventName: "RefundSkipped",
      });
      return decoded.eventName === "RefundSkipped";
    } catch {
      // Not a RefundSkipped log (a different event from this same clone in the same tx, or a log
      // this ABI cannot decode at all) - never treated as a skip.
      return false;
    }
  });
  return skipped ? "skipped" : "refunded";
}

/** Exact copy Kenneth specified (plan section "Refund feedback"). */
export function refundFeedbackMessage(outcome: RefundOutcome): string {
  return outcome === "refunded"
    ? "Gas refunded by the clinic contract"
    : "Refund skipped, the clinic's refund pool is low: tell your admin";
}
