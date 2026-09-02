import "server-only";
import {ArtifactImportSession, type ArtifactImportSessionDoc} from "@/lib/models/ArtifactImportSession";
import {Pet, buildPetSearchKey, type PetDoc} from "@/lib/models/Pet";
import {createTagArtifact} from "@/lib/tags/artifact";
import {identityLeafSelfCheckSubset} from "@/lib/tags/verifier";
import type {
  AttachTagFields,
  AttachToExistingPetResult,
  AttributeMergeField,
  ExistingPetAttributes,
  ImportFlowStore,
  ImportSessionRow,
  ImportTargetPetPreview,
} from "@/lib/tags/importFlow";

function toImportSessionRow(doc: ArtifactImportSessionDoc): ImportSessionRow {
  return {
    token: doc.token,
    targetPetId: doc.targetPetId,
    clinicName: doc.clinicName,
    ourCloneAddress: doc.cloneAddress,
    exp: doc.exp,
    usedAt: doc.usedAt,
  };
}

function dogTagSubdoc(tag: AttachTagFields) {
  return {
    dogTagIdDec: tag.dogTagIdDec,
    dogTagIdField: tag.dogTagIdField,
    root: tag.root.toLowerCase(),
    cloneAddress: tag.issuerClone.toLowerCase(),
    status: "active" as const,
    external: tag.external,
  };
}

function importConflictsField(conflicts: AttributeMergeField[], now: number) {
  return conflicts.length > 0 ? {detectedAt: now, fields: conflicts} : undefined;
}

/** Mongoose-backed `ImportFlowStore` - the production adapter for `lib/tags/importFlow.ts`'s pure
 * logic, mirroring `lib/registration/mongoStore.ts`/`lib/tags/exportMongoAdapter.ts`.
 * `connectToDatabase()` is assumed already called by the route handler. */
export const mongoImportStore: ImportFlowStore = {
  async getByToken(token) {
    const doc = await ArtifactImportSession.findOne({token}).lean<ArtifactImportSessionDoc>();
    return doc ? toImportSessionRow(doc) : null;
  },

  async tryConsume(token, now) {
    const updated = await ArtifactImportSession.findOneAndUpdate(
      {token, usedAt: {$exists: false}},
      {$set: {usedAt: now}},
      {new: true},
    ).lean<ArtifactImportSessionDoc>();
    return Boolean(updated);
  },

  async previewTargetPet(petId): Promise<ImportTargetPetPreview | null> {
    const pet = await Pet.findOne({petId}).lean<Pick<PetDoc, "name" | "dogTag">>();
    if (!pet) return null;
    const hasActiveTag = pet.dogTag?.status === "active" && Boolean(pet.dogTag?.dogTagIdDec);
    return {name: pet.name, hasActiveTag};
  },

  async findExistingPetAttributes(petId): Promise<ExistingPetAttributes | null> {
    const pet = await Pet.findOne({petId}).lean<Pick<PetDoc, "name" | "species" | "breed" | "sex" | "dateOfBirth">>();
    if (!pet) return null;
    return {name: pet.name, species: pet.species, breed: pet.breed, sex: pet.sex, dateOfBirth: pet.dateOfBirth};
  },

  async attachToExistingPet(petId, resolvedAttributes, tag, conflicts, now): Promise<AttachToExistingPetResult> {
    // ONE atomic conditional write - matches only a pet with no tag yet OR a revoked one. See
    // this method's own doc comment on ImportFlowStore (lib/tags/importFlow.ts) for why this,
    // not the earlier previewTargetPet call, is what actually prevents two concurrent imports
    // from both attaching to the same target - the same "one round trip, no check-then-write
    // window" shape lib/registration/mongoStore.ts's appendWalletToClient already established.
    const conflictsField = importConflictsField(conflicts, now);
    const updated = await Pet.findOneAndUpdate(
      {
        petId,
        $or: [{"dogTag.dogTagIdDec": {$exists: false}}, {"dogTag.status": "revoked"}],
      },
      {
        $set: {
          ...(resolvedAttributes.name !== undefined ? {name: resolvedAttributes.name} : {}),
          ...(resolvedAttributes.species !== undefined ? {species: resolvedAttributes.species} : {}),
          ...(resolvedAttributes.breed !== undefined ? {breed: resolvedAttributes.breed} : {}),
          ...(resolvedAttributes.sex !== undefined ? {sex: resolvedAttributes.sex} : {}),
          ...(resolvedAttributes.dateOfBirth !== undefined ? {dateOfBirth: resolvedAttributes.dateOfBirth} : {}),
          dogTag: {...dogTagSubdoc(tag), ...(conflictsField ? {importConflicts: conflictsField} : {})},
          searchKey: buildPetSearchKey({
            name: resolvedAttributes.name ?? "",
            species: resolvedAttributes.species,
            breed: resolvedAttributes.breed,
          }),
        },
      },
      {new: true, runValidators: true},
    ).lean<PetDoc>();
    if (!updated) return {ok: false};
    return {ok: true, petName: updated.name};
  },

  async createPetFromImport(attributes, tag) {
    // A brand-new pet has no prior attributes to conflict with, and no existing state to race
    // against - a plain Pet.create, never a conditional write.
    const name = attributes.name?.trim() || "Imported pet";
    const created = await Pet.create({
      name,
      species: attributes.species,
      breed: attributes.breed,
      sex: attributes.sex,
      dateOfBirth: attributes.dateOfBirth,
      ownerClientIds: [],
      dogTag: dogTagSubdoc(tag),
      searchKey: buildPetSearchKey({name, species: attributes.species, breed: attributes.breed}),
    });
    return {petId: created.petId, petName: created.name};
  },

  async createImportedArtifact(input) {
    // No vet-attested identity record to check an imported claim against - the owner.identity.*
    // subset is checked against ITSELF, the same self-check lib/tags/verifier.ts's
    // verifyTagDataAgainstRoot already performed moments earlier with these same leaves (every
    // gate has already passed by the time completeImport calls this).
    const result = await createTagArtifact({
      petId: input.petId,
      dogTagIdDec: input.dogTagIdDec,
      dogTagIdField: input.dogTagIdField,
      root: input.root,
      protocolVersion: "dogtag-v2/1",
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
};
