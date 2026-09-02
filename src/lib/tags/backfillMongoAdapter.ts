import "server-only";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {MintSession, type MintSessionDoc} from "@/lib/models/MintSession";
import {TagArtifact, type TagArtifactDoc} from "@/lib/models/TagArtifact";
import {createTagArtifact, findActiveTagArtifact} from "@/lib/tags/artifact";
import type {BackfillMintSession, BackfillPet, BackfillStore} from "@/lib/tags/backfill";

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
