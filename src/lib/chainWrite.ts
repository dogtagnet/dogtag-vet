import type {Abi, EstimateContractGasParameters, PublicClient} from "viem";

/**
 * Every ROAX chain write in this repo goes through this one function, so "ROAX only ever accepts
 * legacy transactions" (`src/lib/chains.ts`'s doc comment on `roax`) is enforced in exactly one
 * place rather than each call site remembering to pass `type: "legacy"` itself. Used at every
 * `writeContractAsync` call site that targets ROAX: `issueTag`, `revokeTag`, `reactivateTag`,
 * `recordVerificationZK`.
 */
export function legacyTx<T extends object>(params: T): T & {type: "legacy"} {
  return {...params, type: "legacy"};
}

/**
 * `legacyTx` plus an app-computed gas limit with HEADROOM (estimate + 20% + 30k), instead of
 * letting the wallet send the bare estimate. Live incident (2026-09-01, WP4.5 track 3): `issueTag`
 * executed its whole body then hit OutOfGas on the clone's gas-REFUND tail - MetaMask's limit was
 * the bare estimate (335037) and 330263 was used, so the refund's final ops starved and the whole
 * tx reverted (txs 0x61509364...44b2, 0x2e5096f5...). Refund-tail writes are exactly the shape
 * estimators undercount; every VetIssuer/VerificationRegistry write here shares that hazard.
 * Fail-open on estimation problems: no public client or a failed estimate returns plain
 * `legacyTx(params)` (the wallet estimates, as before) rather than blocking the write.
 */
export async function legacyTxWithGas<
  T extends {address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[]; account: `0x${string}`},
>(publicClient: PublicClient | undefined, params: T): Promise<T & {type: "legacy"; gas?: bigint}> {
  const base = legacyTx(params);
  if (!publicClient) return base;
  try {
    const estimated = await publicClient.estimateContractGas({
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args,
      account: params.account,
    } as unknown as EstimateContractGasParameters);
    return {...base, gas: estimated + estimated / 5n + 30_000n};
  } catch {
    return base;
  }
}
