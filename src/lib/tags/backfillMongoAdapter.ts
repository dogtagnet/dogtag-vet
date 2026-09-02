import "server-only";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {MintSession, type MintSessionDoc} from "@/lib/models/MintSession";
import {TagArtifact, type TagArtifactDoc} from "@/lib/models/TagArtifact";
import {createTagArtifact, findActiveTagArtifact} from "@/lib/tags/artifact";
import type {BackfillMintSession, BackfillPet, BackfillStore, SchemaIdRepairRow, SchemaIdRepairStore} from "@/lib/tags/backfill";

/** Mongoose-backed `BackfillStore` - the production adapter `scripts/backfillTagArtifacts.ts` runs
 * for real. `connectToDatabase()` is assumed already called by the script, same convention as every
 * other model access in this repo (`lib/mint/mongoStore.ts`'s own doc comment). */
export const mongoBackfillStore: BackfillStore = {
  async listPetsWithRoot(): Promise<BackfillPet[]> {
    const pets = await Pet.find({"dogTag.root": {$exists: true, $ne: null}}).lean<PetDoc[]>();
    return pets
      .filter((p) => Boolean(p.dogTag?.root))
      .map((p) => ({
        petId: p.petId,
        dogTagIdDec: p.dogTag.dogTagIdDec,
        dogTagIdField: p.dogTag.dogTagIdField,
        root: p.dogTag.root!,
        cloneAddress: p.dogTag.cloneAddress,
        external: p.dogTag.external,
      }));
  },

  async findActiveArtifactRoot(petId) {
    const active = await findActiveTagArtifact(petId);
    return active ? active.root : null;
  },

  async findArtifactByRoot(root) {
    const doc = await TagArtifact.findOne({root}).lean<Pick<TagArtifactDoc, "petId" | "active">>();
    return doc ? {petId: doc.petId, active: doc.active} : null;
  },

  async findBoundMintSessionByRoot(root): Promise<BackfillMintSession | null> {
    const session = await MintSession.findOne({root}).lean<MintSessionDoc>();
    if (!session) return null;
    return {
      dogTagIdDec: session.dogTagIdDec,
      dogTagIdField: session.dogTagIdField,
      boundLeaves: session.boundLeaves,
      reservedLeafHashes: session.reservedLeafHashes,
      identityLeaves: session.identityLeaves,
      protocolVersion: session.protocolVersion,
    };
  },

  createArtifact: createTagArtifact,
};

/** Mongoose-backed `SchemaIdRepairStore` - the production adapter for `backfill.ts`'s
 * `repairMissingSchemaIds`. `{schemaId: {$exists: false}}` matches exactly what a `TagArtifact.
 * create()` call with `schemaId: undefined` actually persists (mongoose omits the path entirely
 * when neither a value nor a schema `default` applies - `schemaId` has no `default` - so an unset
 * field is genuinely ABSENT, never a stored `null`). */
export const mongoSchemaIdRepairStore: SchemaIdRepairStore = {
  async listArtifactsMissingSchemaId(): Promise<SchemaIdRepairRow[]> {
    const rows = await TagArtifact.find({schemaId: {$exists: false}}).lean<Pick<TagArtifactDoc, "artifactId" | "petId" | "root">[]>();
    return rows.map((r) => ({artifactId: r.artifactId, petId: r.petId, root: r.root}));
  },

  async stampSchemaId(artifactId, schemaId): Promise<boolean> {
    // Re-checks "still unset" at write time (never a blind $set) - see this store's own doc
    // comment on `backfill.ts`'s SchemaIdRepairStore for why this is what keeps a concurrent
    // repair run, or an ordinary write landing on the same row in the interim, from clobbering a
    // value someone else legitimately set between the list read and this write.
    const result = await TagArtifact.updateOne({artifactId, schemaId: {$exists: false}}, {$set: {schemaId}});
    return result.modifiedCount > 0;
  },
};
