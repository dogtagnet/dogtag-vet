import type {Abi, EstimateContractGasParameters, PublicClient} from "viem";

/**
 * Every ROAX chain write in this repo goes through this one function, so "ROAX only ever accepts
 * legacy transactions" (`src/lib/chains.ts`'s doc comment on `roax`) is enforced in exactly one
 * place rather than each call site remembering to pass `type: "legacy"` itself. Used at every
 * `writeContractAsync` call site that targets ROAX: `issueTag`, `revokeTag`, `reactivateTag`,
 * `recordVerificationZK`, `relayVerification`, `addSecondaryOwner`, `revokeSecondaryOwner`,
 * `issueRecord`, `revokeRecord`.
 */
export function legacyTx<T extends object>(params: T): T & {type: "legacy"} {
  return {...params, type: "legacy"};
}

/**
 * GAS FLOORS - a hard per-function minimum gas limit that `legacyTxWithGas` NEVER goes below, no
 * matter what `estimateContractGas` says (or whether it can be called at all). Every VetIssuer/
 * VerificationRegistry write on ROAX ends in a `refundsGas`-wrapped refund-transfer TAIL
 * (`plans/wp4.15-multi-owner.md` section 8) - exactly the shape `eth_estimateGas` undercounts,
 * because estimation runs at gas price 0 and the refund transfer's cost depends on `tx.gasprice`
 * (zero at estimate time, real at send time), so the refund tail's actual gas cost is invisible to
 * the estimate that is supposed to be sizing for it.
 *
 * Two live incidents proved BOTH the undercount and the fail-open hazard:
 *  - 2026-09-01 (WP4.5 track 3, hot-fix 2435077): `issueTag` limit 335037 (the bare, no-headroom
 *    wallet estimate) / 330263 used - txs 0x61509364...44b2, 0x2e5096f5.... `legacyTxWithGas` was
 *    added right after this with the estimate+20%+30k formula, but it FAILED OPEN (no public
 *    client, or a throwing estimate, returned the bare params) - the formula only ever helps when
 *    the estimate call itself succeeds.
 *  - 2026-09-25 (workstation deployment): `issueTag` tx
 *    0xfb3414bac482635a0aa9c4a57e430ddf8a7ce6fb5cd5994564a45b38c5bfea47 on ROAX (chain 135) to
 *    clone 0x22AbED04f8Cc6A78Fc92708e0F23E41183FFDAE4 failed with status 0: gas limit 335338 -
 *    EXACTLY the node's bare `eth_estimateGas` (gas price 0, so the refund transfer's real cost
 *    was skipped in the estimate but still executed for real), 330559 used. The fail-open path
 *    reached the wallet again. Floors below are a hard backstop independent of whether the
 *    estimate call succeeds, throws, or simply under-reports: `gas` is
 *    `max(estimate + 20% + 30_000, floor)` whenever the estimate succeeds, and `floor` alone when
 *    it fails or there is no public client - the wallet's own bare estimate is NEVER used again.
 *
 * Per-function floors, each with margin over its own measured worst case (never the bare measured
 * number itself):
 *  - `issueTag` / `revokeTag` / `reactivateTag` / `issueRecord` / `revokeRecord`: the same clone
 *    refund-tail write shape `issueTag` itself is (`plans/wp4.15-multi-owner.md` section 8: sponsored
 *    "issueTag, issueRecord, revoke/reactivate tag and record"). Measured `issueTag` cost: 330263
 *    -> 330559 used across both incidents; `cast estimate --gas-price 1000007` (a REAL, non-zero
 *    gas price, so the refund path is actually costed) returned 342393. Floor set well above that.
 *  - `recordVerificationZK` (direct, unsponsored - `VerificationRegistryConsent`, no clone refund
 *    tail - plan section 8) and `relayVerification` (the clone-relayed, `refundsGas`-wrapped
 *    version of the same call): measured via `forge test --gas-report`
 *    (`plans/orchestration/wp4.15B-grade.md`): `relayVerification` 332,183 gas total, of which the
 *    inner `recordVerificationZK` call is 272,258. Both floors sit above their own measured number.
 *  - `addSecondaryOwner` / `revokeSecondaryOwner`: dominated by 15 linked `PoseidonT4` delegatecalls
 *    (~83k gas each) rebuilding the delegation tree. Measured (`plans/orchestration/
 *    wp4.15B-progress.md` gas report): `add` avg ~1.34M / max 1.50M; `revoke` avg ~1.12M / max
 *    1.40M. Floors sit above each function's own measured max.
 *  - Anything else (a future ROAX write this table does not yet name): `DEFAULT_GAS_FLOOR`, the
 *    same order of magnitude as the simple clone writes above - never `0n`, so an unrecognized
 *    `functionName` still gets real headroom instead of silently falling through to the bare
 *    estimate.
 */
export const GAS_FLOORS: Readonly<Record<string, bigint>> = {
  issueTag: 400_000n,
  revokeTag: 400_000n,
  reactivateTag: 400_000n,
  issueRecord: 400_000n,
  revokeRecord: 400_000n,
  recordVerificationZK: 350_000n,
  relayVerification: 400_000n,
  addSecondaryOwner: 1_600_000n,
  revokeSecondaryOwner: 1_500_000n,
};

/** The floor applied to any ROAX write whose `functionName` is not a key of `GAS_FLOORS` above -
 * see that constant's own doc comment for why this is never `0n`. */
export const DEFAULT_GAS_FLOOR = 400_000n;

function gasFloorFor(functionName: string): bigint {
  return GAS_FLOORS[functionName] ?? DEFAULT_GAS_FLOOR;
}

/**
 * `legacyTx` plus an app-computed gas limit that NEVER fails open to the wallet's own bare
 * estimate - see `GAS_FLOORS`'s own doc comment for the two live incidents this replaces the
 * original "estimate + 20% + 30k, fail-open" hot-fix with. `gas` is:
 *  - `max(estimate + 20% + 30_000, floor)` when `estimateContractGas` succeeds - the existing
 *    headroom formula, now with a hard floor under it so a systematically-low estimate (the
 *    refund-tail undercount both incidents traced to) can no longer slip through.
 *  - `floor` alone when there is no public client, or the estimate call throws - logged with
 *    `console.warn` naming the function and the reason (never silent) so a fail-open in production
 *    is visible in the browser console instead of looking identical to a normal headroom send.
 */
export async function legacyTxWithGas<
  T extends {address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[]; account: `0x${string}`},
>(publicClient: PublicClient | undefined, params: T): Promise<T & {type: "legacy"; gas: bigint}> {
  const base = legacyTx(params);
  const floor = gasFloorFor(params.functionName);
  if (!publicClient) {
    console.warn(`legacyTxWithGas(${params.functionName}): no public client - using the gas floor (${floor}) instead of an estimate.`);
    return {...base, gas: floor};
  }
  try {
    const estimated = await publicClient.estimateContractGas({
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args,
      account: params.account,
    } as unknown as EstimateContractGasParameters);
    const withHeadroom = estimated + estimated / 5n + 30_000n;
    return {...base, gas: withHeadroom > floor ? withHeadroom : floor};
  } catch (err) {
    console.warn(
      `legacyTxWithGas(${params.functionName}): estimateContractGas threw - using the gas floor (${floor}) instead of the wallet's own bare estimate.`,
      err,
    );
    return {...base, gas: floor};
  }
}
