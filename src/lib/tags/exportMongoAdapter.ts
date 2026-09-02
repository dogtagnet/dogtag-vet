import "server-only";
import {ArtifactExportSession, type ArtifactExportSessionDoc} from "@/lib/models/ArtifactExportSession";
import {TagArtifact, type TagArtifactDoc} from "@/lib/models/TagArtifact";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import type {ExportedArtifactRow, ExportFlowStore, ExportSessionRow} from "@/lib/tags/exportFlow";

function toExportSessionRow(doc: ArtifactExportSessionDoc): ExportSessionRow {
  return {token: doc.token, petId: doc.petId, root: doc.root, exp: doc.exp, usedAt: doc.usedAt};
}

function toExportedArtifactRow(doc: TagArtifactDoc): ExportedArtifactRow {
  return {
    protocolVersion: doc.protocolVersion,
    schemaId: doc.schemaId,
    dogTagIdDec: doc.dogTagIdDec,
    dogTagIdField: doc.dogTagIdField,
    root: doc.root,
    leaves: doc.leaves,
    reservedLeafHashes: doc.reservedLeafHashes,
    issuerClone: doc.issuerClone,
    active: doc.active,
  };
}

/** Mongoose-backed `ExportFlowStore` - the production adapter for `lib/tags/exportFlow.ts`'s pure
 * logic, mirroring `lib/registration/mongoStore.ts`. `connectToDatabase()` is assumed already
 * called by the route handler, same convention as every other model access in this repo. */
export const mongoExportStore: ExportFlowStore = {
  async getByToken(token) {
    const doc = await ArtifactExportSession.findOne({token}).lean<ArtifactExportSessionDoc>();
    return doc ? toExportSessionRow(doc) : null;
  },

  async tryConsume(token, now) {
    const updated = await ArtifactExportSession.findOneAndUpdate(
      {token, usedAt: {$exists: false}},
      {$set: {usedAt: now}},
      {new: true},
    ).lean<ArtifactExportSessionDoc>();
    return Boolean(updated);
  },

  async findArtifactByPetAndRoot(petId, root) {
    const doc = await TagArtifact.findOne({petId, root: root.toLowerCase()}).lean<TagArtifactDoc>();
    return doc ? toExportedArtifactRow(doc) : null;
  },

  async findPetForExport(petId) {
    const pet = await Pet.findOne({petId}).lean<Pick<PetDoc, "name" | "dogTag">>();
    return pet ? {name: pet.name, dogTagStatus: pet.dogTag?.status} : null;
  },

  async getClinicName() {
    const settings = await getClinicSettings();
    return settings.businessProfile?.name?.trim() || undefined;
  },
};
