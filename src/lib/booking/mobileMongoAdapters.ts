import "server-only";
import type {Address} from "viem";
import {Appointment} from "@/lib/models/Appointment";
import {Client} from "@/lib/models/Client";
import {Pet, buildPetSearchKey, type PetDoc} from "@/lib/models/Pet";
import {readIsValidRoot, readProfileRoot, readRootIssuer} from "@/lib/chainRead";
import {appendBookingWalletToClient} from "@/lib/booking/clientMatch";
import type {MobileTagChainDeps, MobileTagLookupStore} from "@/lib/booking/mobileReconcile";
import type {PostBookingStore} from "@/lib/booking/postBooking";
import {createTagArtifact} from "@/lib/tags/artifact";
import {identityLeafSelfCheckSubset} from "@/lib/tags/verifier";
import {DOG_PROFILE_SCHEMA_ID} from "@/lib/tags/schemaIds";

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
    const pet = await Pet.findOne({$or: or}).lean<Pick<PetDoc, "petId" | "name" | "ownerClientIds">>();
    return pet ? {petId: pet.petId, name: pet.name, ownerClientIds: pet.ownerClientIds} : null;
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

/** Mongoose-backed `PostBookingStore` (review finding 4) - each write preserves the exact shape
 * the booking route performed inline before the extraction: the same `$addToSet` owner/pet links,
 * the same provisional `Pet.create` fields (`external: true`, `status: "active"`, searchKey from
 * the imported attributes), the same appointment link write, and the SAME
 * `appendBookingWalletToClient` atomic push the route already used. */
export const mongoPostBookingStore: PostBookingStore = {
  async findPetName(petId) {
    const pet = await Pet.findOne({petId}).lean<Pick<PetDoc, "name">>();
    return pet?.name ?? null;
  },

  async addOwnerToPet(petId, clientId) {
    await Pet.updateOne({petId}, {$addToSet: {ownerClientIds: clientId}});
  },

  async addPetToClient(clientId, petId) {
    await Client.updateOne({clientId}, {$addToSet: {petIds: petId}});
  },

  async createExternalPet(input) {
    const created = await Pet.create({
      name: input.name,
      species: input.species,
      breed: input.breed,
      sex: input.sex,
      dateOfBirth: input.dateOfBirth,
      color: input.color,
      registrationId: input.registrationId,
      registrationAuthority: input.registrationAuthority,
      ownerClientIds: [input.ownerClientId],
      dogTag: {
        dogTagIdDec: input.dogTag.dogTagIdDec,
        dogTagIdField: input.dogTag.dogTagIdField,
        root: input.dogTag.root,
        cloneAddress: input.dogTag.cloneAddress,
        status: "active",
        external: true,
      },
      searchKey: buildPetSearchKey({name: input.name, species: input.species, breed: input.breed}),
    });
    return {petId: created.petId};
  },

  async linkAppointmentPet(appointmentId, petId, petName) {
    await Appointment.updateOne({appointmentId}, {$set: {petIds: [petId], petName}});
  },

  async createImportedArtifact(input) {
    // No vet-attested identity record to check an imported claim against - the `owner.identity.*`
    // subset is checked against ITSELF, the same self-check `lib/tags/verifier.ts`'s
    // `verifyTagDataAgainstRoot` already performed moments earlier with these same leaves (Q3 has
    // already passed by the time this runs - `runSideEffects` only calls this when `dataVerified`).
    // `createTagArtifact` is idempotent for a repeat (petId, root) pair, so this is safe to call on
    // BOTH the "create a new external pet" and the "reuse an already-imported one" paths without a
    // separate existence check here - a reused pet's already-on-file root simply no-ops.
    const result = await createTagArtifact({
      petId: input.petId,
      dogTagIdDec: input.dogTagIdDec,
      dogTagIdField: input.dogTagIdField,
      root: input.root,
      protocolVersion: "dogtag-v2/1",
      // WP4.10V item 2: this mobile-booking claim always carries the FULL leaf set for the one
      // record type this app has ever custodied (schemaIds.ts) - the EIP-712 booking wire format
      // has no schemaId field of its own to thread through, unlike the WP4.9 import ceremony's
      // artifact-export payload, so this is a hardcoded stamp exactly like custodial-bind's.
      schemaId: DOG_PROFILE_SCHEMA_ID,
      leaves: input.leaves,
      reservedLeafHashes: input.reservedLeafHashes,
      expectedIdentityLeaves: identityLeafSelfCheckSubset(input.leaves),
      source: "imported",
      issuerClone: input.issuerClone,
      now: input.now,
    });
    if (!result.ok) {
      throw new Error(`createTagArtifact refused the imported artifact for pet ${input.petId}: ${result.reason}`);
    }
  },

  appendBookingWallet: appendBookingWalletToClient,

  async flagPostBookingIncomplete(appointmentId) {
    await Appointment.updateOne({appointmentId}, {$set: {"bookingIdentity.postBookingIncomplete": true}});
  },
};
