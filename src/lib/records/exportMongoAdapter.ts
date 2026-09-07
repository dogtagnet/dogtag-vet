import "server-only";
import {ArtifactExportSession, type ArtifactExportSessionDoc} from "@/lib/models/ArtifactExportSession";
import {RecordArtifact, type RecordArtifactDoc} from "@/lib/models/RecordArtifact";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import type {ExportedRecordRow, RecordExportFlowStore, RecordExportSessionRow} from "@/lib/records/exportFlow";

function toRecordExportSessionRow(doc: ArtifactExportSessionDoc): RecordExportSessionRow {
  // `recordId` is only ever absent on a row this adapter itself never wrote (a tag session) - the
  // route dispatches by `artifactType` BEFORE ever calling into this store (see `/e/[token]/route.ts`),
  // so a real call here always has one; the `?? ""` is a type-satisfying fallback only, never a value
  // any genuine record-export lookup below would actually see.
  return {token: doc.token, petId: doc.petId, recordId: doc.recordId ?? "", root: doc.root, exp: doc.exp, mask: doc.mask, usedAt: doc.usedAt};
}

function toExportedRecordRow(doc: RecordArtifactDoc): ExportedRecordRow {
  return {
    protocolVersion: doc.protocolVersion,
    schemaId: doc.schemaId,
    recordType: doc.recordType,
    root: doc.root,
    leaves: doc.leaves,
    obfuscatedLeafHashes: doc.obfuscatedLeafHashes ?? [],
    nonMaskable: doc.nonMaskable,
    conformsTo: doc.conformsTo ?? [],
    status: doc.status,
    chain: doc.chain,
  };
}

/** Mongoose-backed `RecordExportFlowStore` - the production adapter for `lib/records/exportFlow.ts`'s
 * pure logic, mirroring `lib/tags/exportMongoAdapter.ts`'s structure exactly, over the RecordArtifact
 * collection instead of TagArtifact. Shares the SAME `ArtifactExportSession` collection as the tag
 * adapter (one export-session table for both artifact types), never a second collection. */
export const mongoRecordExportStore: RecordExportFlowStore = {
  async getByToken(token) {
    const doc = await ArtifactExportSession.findOne({token}).lean<ArtifactExportSessionDoc>();
    return doc ? toRecordExportSessionRow(doc) : null;
  },

  async tryConsume(token, now) {
    const updated = await ArtifactExportSession.findOneAndUpdate(
      {token, usedAt: {$exists: false}},
      {$set: {usedAt: now}},
      {new: true},
    ).lean<ArtifactExportSessionDoc>();
    return Boolean(updated);
  },

  async findRecordByIdAndRoot(recordId, root) {
    const doc = await RecordArtifact.findOne({recordId, root: root.toLowerCase()}).lean<RecordArtifactDoc>();
    return doc ? toExportedRecordRow(doc) : null;
  },

  async findPetForExport(petId) {
    const pet = await Pet.findOne({petId}).lean<Pick<PetDoc, "name">>();
    return pet ? {name: pet.name} : null;
  },

  async getClinicName() {
    const settings = await getClinicSettings();
    return settings.businessProfile?.name?.trim() || undefined;
  },
};
