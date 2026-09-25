import {formatUnits} from "viem";

/**
 * WP4.19 V3 - the pre-flight balance check `TagIssueWizard.tsx`/`TagsTable.tsx` run before ever
 * sending `issueTag`/`revokeTag`/`reactivateTag`: the operator wallet fronts gas for every clinic
 * write (`chainWrite.ts`'s own doc comment - the clone refunds it AFTER the write confirms, never
 * before), so a wallet that cannot even cover `gasFloor * current gas price` is certain to fail
 * with a wallet-level "insufficient funds" error with no useful message - this repo would rather
 * refuse up front with a clear, actionable one (plan section 2: "a clear message otherwise").
 *
 * Deliberately the SAME per-function floor `legacyTxWithGas` itself falls back to
 * (`GAS_FLOORS`/`DEFAULT_GAS_FLOOR` in `chainWrite.ts`) - not the live `estimateContractGas`
 * result, which this repo's own gas-floor incident (2026-09-25) proved can be systematically LOW
 * for exactly the refund-tail writes this preflight guards (`chainWrite.ts`'s own doc comment on
 * the incident). Checking against the floor, never a possibly-undercounted estimate, means this
 * preflight can never wave through a wallet that `legacyTxWithGas` would then, correctly, still
 * size a floor-sized transaction for.
 */
export interface GasPreflightResult {
  /** `true` when `balanceWei` covers `gasFloor * gasPriceWei` - the wallet may proceed. */
  ok: boolean;
  /** The exact wei amount `gasFloor * gasPriceWei` - what the wallet needs at minimum, in the
   * native PLASMA asset, before this specific write's `legacyTxWithGas` call is even attempted. */
  neededWei: bigint;
}

/** Pure arithmetic, no chain access - `balanceWei`/`gasPriceWei` are the live reads
 * (`publicClient.getBalance`/`getGasPrice`) a caller already has by the time it checks this. */
export function checkGasPreflight(balanceWei: bigint, gasPriceWei: bigint, gasFloor: bigint): GasPreflightResult {
  const neededWei = gasFloor * gasPriceWei;
  return {ok: balanceWei >= neededWei, neededWei};
}

/** A short, human decimal amount for `neededWei`/a balance - e.g. `"0.000084"` for 84000000000000
 * wei. Never more than 6 fraction digits (this repo's other PLASMA amounts are all sub-cent gas
 * costs or round clinic top-up amounts - `format.ts`'s `formatTokenAmount` stays exact/un-rounded
 * for payment amounts, which this is deliberately NOT: a preflight message says "about X", never a
 * payment-matching amount a payer must send exactly) and never scientific notation. Trailing zeros
 * (and a trailing decimal point with nothing after it) are trimmed so a whole-PLASMA amount reads
 * as `"1"`, not `"1.000000"`. */
export function formatPlasmaApprox(amountWei: bigint): string {
  const full = formatUnits(amountWei, 18);
  const [whole = "0", fraction = ""] = full.split(".");
  const trimmedFraction = fraction.slice(0, 6).replace(/0+$/, "");
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
}

/** The exact copy Kenneth specified (plan section "Pre-flight"): "Your wallet needs about X PLASMA
 * for this transaction; ask your admin for a top-up". */
export function gasPreflightMessage(neededWei: bigint): string {
  return `Your wallet needs about ${formatPlasmaApprox(neededWei)} PLASMA for this transaction; ask your admin for a top-up`;
}
