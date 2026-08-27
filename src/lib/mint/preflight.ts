import "server-only";
import {requireEnv} from "@/lib/env";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {readEntityActive, readOperatorWhitelisted} from "@/lib/chainRead";

export type PreflightResult =
  | {ok: true; cloneAddress: `0x${string}`; entityAccount: `0x${string}`}
  | {ok: false; message: string};

/**
 * wp4-vet.md issuance step 2's preflight, run before ANY allocation happens ("each failure
 * returns a clear operator message and allocates nothing"): protocol addresses configured, clone
 * discovered and entity `Active` in `EntityRegistry`, connected operator wallet whitelisted on
 * the clone. Shared by the mint-session start route and the retry route - both must allocate
 * nothing on failure, so both run this exact same check before touching the counter.
 */
export async function preflightIssuance(operatorAddress: `0x${string}`): Promise<PreflightResult> {
  let entityRegistryAddress: `0x${string}`;
  try {
    entityRegistryAddress = requireEnv("ENTITY_REGISTRY_ADDRESS") as `0x${string}`;
    requireEnv("DOGTAG_SBT_ADDRESS");
  } catch {
    return {ok: false, message: "Protocol addresses are not configured. Finish setup first."};
  }

  const settings = await getClinicSettings();
  if (!settings.cloneAddress || !settings.entityAccount) {
    return {ok: false, message: "This clinic has not completed setup. Discover and save your clone first."};
  }
  const cloneAddress = settings.cloneAddress as `0x${string}`;
  const entityAccount = settings.entityAccount as `0x${string}`;

  let entityActive: boolean;
  let operatorWhitelisted: boolean;
  try {
    [entityActive, operatorWhitelisted] = await Promise.all([
      readEntityActive(entityRegistryAddress, entityAccount),
      readOperatorWhitelisted(cloneAddress, operatorAddress),
    ]);
  } catch {
    return {ok: false, message: "Could not reach the chain to verify clinic status. Try again shortly."};
  }

  if (!entityActive) {
    return {ok: false, message: "This entity is not active in the registry. Contact the DogTag admin."};
  }
  if (!operatorWhitelisted) {
    return {ok: false, message: "Your connected wallet is not a whitelisted operator on this clinic's clone."};
  }

  return {ok: true, cloneAddress, entityAccount};
}
