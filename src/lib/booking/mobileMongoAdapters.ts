import "server-only";
import type {Address} from "viem";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {readIsValidRoot, readProfileRoot, readRootIssuer} from "@/lib/chainRead";
import type {MobileTagChainDeps, MobileTagLookupStore} from "@/lib/booking/mobileReconcile";

/** Mongoose-backed `MobileTagLookupStore` - the production adapter for `resolveTagClaim`'s
 * database reads, mirroring every other `mongo*Store`/`mongo*Deps` factory in this app
 * (`lib/booking/mongoStore.ts`, `lib/mint/reconcile.ts`'s `mongoReconcileDeps`). */
export const mongoMobileTagLookupStore: MobileTagLookupStore = {
  async findLocalPetByDogTag({dogTagIdDec, dogTagIdField}) {
    const or = [
      ...(dogTagIdDec ? [{"dogTag.dogTagIdDec": dogTagIdDec}] : []),
      ...(dogTagIdField ? [{"dogTag.dogTagIdField": dogTagIdField}] : []),
    ];
    if (or.length === 0) return null;
    const pet = await Pet.findOne({$or: or}).lean<Pick<PetDoc, "petId" | "ownerClientIds">>();
    return pet ? {petId: pet.petId, ownerClientIds: pet.ownerClientIds} : null;
  },

  async findExternalPetByDogTagField(dogTagIdFieldDec) {
    const pet = await Pet.findOne({"dogTag.dogTagIdField": dogTagIdFieldDec, "dogTag.external": true}).lean<Pick<PetDoc, "petId">>();
    return pet ? {petId: pet.petId} : null;
  },
};

/** Mongoose + real-chain `MobileTagChainDeps` - `sbtAddress`/`factoryAddress` are this
 * deployment's configured `DOGTAG_SBT_ADDRESS`/`VET_ISSUER_FACTORY_ADDRESS` (the booking route
 * requires both before attempting tier resolution at all - see its own doc comment for what
 * happens when either is unset). */
export function mongoMobileTagChainDeps(sbtAddress: Address, factoryAddress: Address): MobileTagChainDeps {
  return {
    readProfileRoot: (dogTagIdFieldDec) => readProfileRoot(sbtAddress, dogTagIdFieldDec),
    readRootIssuer: (root) => readRootIssuer(factoryAddress, root),
    readIsValidRoot: (issuerCloneAddress, root) => readIsValidRoot(issuerCloneAddress as Address, root as `0x${string}`),
  };
}

/** For a deployment that has not yet configured `DOGTAG_SBT_ADDRESS`/`VET_ISSUER_FACTORY_ADDRESS`
 * (the setup wizard's onboarding reads already treat an unset factory address as "not configured
 * yet", never as `address(0)` on chain - `env.ts`'s own doc comment). Every read throws, which
 * `resolveTagClaim` already folds to `{tagResolution: "unknown", verificationError: true}` for any
 * claim that gets past the LOCAL tier (a local match needs no chain config at all) - this reuses
 * that existing fail-closed path rather than adding a second "not configured" branch to it. */
export function unconfiguredMobileTagChainDeps(): MobileTagChainDeps {
  const notConfigured = (): Promise<never> => Promise.reject(new Error("Chain not configured for tag verification."));
  return {readProfileRoot: notConfigured, readRootIssuer: notConfigured, readIsValidRoot: notConfigured};
}
