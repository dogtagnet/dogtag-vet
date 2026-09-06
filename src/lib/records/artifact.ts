import "server-only";
import {verifyRecordArtifact, RECORD_NON_MASKABLE_KEY_PATHS, type OpenedLeaf, type RecordArtifact as RecordArtifactWire} from "@dogtag/standard";
import {
  RecordArtifact,
  type RecordArtifactDoc,
  type RecordArtifactType,
  type RecordConformsTo,
} from "@/lib/models/RecordArtifact";

/**
 * The ONE write path onto `RecordArtifact` (plan section 11.2 item V3) - mirrors `lib/tags/
 * artifact.ts`'s own invariant for `TagArtifact` ("no row is ever inserted without the vendored
 * verifier passing right there"), dispatched by `protocolVersion` the identical way. Simpler than
 * its tag sibling in exactly the ways this file's own model doc comment already explains: no
 * `supersedeActiveArtifactsForPet` equivalent (a pet has MANY independent records, never one
 * superseding another), and every row this wave ever creates is fully disclosed
 * (`obfuscatedLeafHashes: []` always - masking is an EXPORT-time concern, plan section 11.2 V5).
 */
export interface VerifyRecordForProtocolVersionInput {
  protocolVersion: string;
  root: string;
  leaves: OpenedLeaf[];
  schemaId: string;
}

const RECORD_PROTOCOL_VERIFIERS: Record<string, (input: VerifyRecordForProtocolVersionInput) => boolean> = {
  "dogtag-v2/1": (input) => {
    const artifact: RecordArtifactWire = {
      protocolVersion: input.protocolVersion,
      artifactType: "record",
      schemaId: input.schemaId,
      root: input.root,
      disclosed: input.leaves,
      obfuscatedLeafHashes: [],
      reservedLeafHashes: [],
    };
    return verifyRecordArtifact(artifact);
  },
};

export type VerifyRecordForProtocolVersionResult = {ok: true} | {ok: false; reason: "leaf_commitment_invalid" | "unsupported_protocol_version"};

/** The pure verify-only half of `createRecordArtifact` - no I/O, dispatched by `protocolVersion`
 * exactly like the write path, mirroring `lib/tags/artifact.ts`'s `verifyForProtocolVersion`. */
export function verifyRecordForProtocolVersion(input: VerifyRecordForProtocolVersionInput): VerifyRecordForProtocolVersionResult {
  const verifier = RECORD_PROTOCOL_VERIFIERS[input.protocolVersion];
  if (!verifier) return {ok: false, reason: "unsupported_protocol_version"};
  return verifier(input) ? {ok: true} : {ok: false, reason: "leaf_commitment_invalid"};
}

export interface CreateRecordArtifactInput {
  petId: string;
  dogTagIdField: string;
  recordType: RecordArtifactType;
  schemaId: string;
  schemaVersion: string;
  protocolVersion: string;
  root: string;
  leaves: OpenedLeaf[];
  chain: {chainId: number; contract: string; operator: string};
  conformsTo?: RecordConformsTo[];
}

export type CreateRecordArtifactResult =
  | {ok: true; record: RecordArtifactDoc}
  | {ok: false; reason: "leaf_commitment_invalid"}
  | {ok: false; reason: "unsupported_protocol_version"};

/**
 * Verify-then-insert, in that order, with NO write happening before verification passes - the
 * identical ordering `createTagArtifact` uses, for the identical reason (a refused insert must
 * never touch the database at all). Every row is created `status: "draft"` - the issuance route
 * (`api/pets/[id]/records/route.ts`) is the only caller, and moves it to `issuing`/`active` itself
 * as the on-chain flow progresses (`api/records/[id]/tx`, `.../confirm`).
 */
export async function createRecordArtifact(input: CreateRecordArtifactInput): Promise<CreateRecordArtifactResult> {
  const verified = verifyRecordForProtocolVersion({
    protocolVersion: input.protocolVersion,
    root: input.root,
    leaves: input.leaves,
    schemaId: input.schemaId,
  });
  if (!verified.ok) return verified;

  const created = await RecordArtifact.create({
    petId: input.petId,
    dogTagIdField: input.dogTagIdField,
    recordType: input.recordType,
    schemaId: input.schemaId,
    schemaVersion: input.schemaVersion,
    protocolVersion: input.protocolVersion,
    root: input.root.toLowerCase(),
    leaves: input.leaves,
    obfuscatedLeafHashes: [],
    nonMaskable: [...RECORD_NON_MASKABLE_KEY_PATHS],
    status: "draft",
    chain: input.chain,
    conformsTo: input.conformsTo ?? [],
  });
  return {ok: true, record: created.toObject()};
}

export async function findRecordArtifact(recordId: string): Promise<RecordArtifactDoc | null> {
  return RecordArtifact.findOne({recordId}).lean<RecordArtifactDoc>();
}

/** The pet's records, newest first (plan section 11.2 V4's own Records-tab list) - uses the
 * `{petId, createdAt: -1}` compound index `RecordArtifact.ts` defines for exactly this query. */
export async function listRecordArtifactsForPet(petId: string): Promise<RecordArtifactDoc[]> {
  return RecordArtifact.find({petId}).sort({createdAt: -1}).lean<RecordArtifactDoc[]>();
}
