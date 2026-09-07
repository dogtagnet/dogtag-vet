import {verifyRecordArtifact, RECORD_NON_MASKABLE_KEY_PATHS, type OpenedLeaf} from "@dogtag/standard";
import {recomputeRecordLeafHash} from "@/lib/records/build";
import type {RecordConformsTo} from "@/lib/models/RecordArtifact";

/**
 * The pure record-export ceremony flow (plan section 11.2 V5) - the record sibling of `lib/tags/
 * exportFlow.ts`'s `resolveAndConsumeExport`, sharing its flow/store-adapter split for the identical
 * reason (unit-testable against an in-memory fake, no database). Deliberately a SEPARATE file, not an
 * edit to `lib/tags/exportFlow.ts` - the plan's own non-negotiable is that the tag path stays
 * byte-identical; this module shares its SESSION collection (`ArtifactExportSession`) but never its
 * code path, so a bug here can never touch a tag export.
 *
 * `recomputeRecordLeafHash` is REUSED from `lib/records/build.ts` (imported directly), not a fourth
 * independent transcription - `build.ts`'s own doc comment on that function already names this file
 * as its intended caller (V2 anticipated V5 exactly this way, unlike the tag side's own three
 * independent transcriptions of the analogous tag-side helper, which that codebase's own header
 * explains a different way for a different reason).
 */
export interface RecordExportSessionRow {
  token: string;
  petId: string;
  recordId: string;
  root: string; // lowercase
  exp: number; // unix seconds
  /** Plan section 11.2 V5 - keyPaths staff chose to mask, snapshotted at session-creation time.
   * Never one of the record's seven non-maskable keyPaths - validated at creation time
   * (`lib/records/exportMask.ts`'s `validateRecordExportMask`), so by the time this ceremony reads
   * it back it is already known-good. */
  mask?: string[];
  usedAt?: number;
}

/** The subset of a `RecordArtifact` (the mongoose doc, not the wire shape of the same name) this
 * ceremony reads. Defined here, not imported from `@/lib/models/RecordArtifact`, so this module stays
 * free of any mongoose dependency - the same flow-module convention `lib/tags/exportFlow.ts` follows. */
export interface ExportedRecordRow {
  protocolVersion: string;
  schemaId: string;
  recordType: string;
  root: string;
  leaves: {keyPath: string; saltHex: string; tag: number; value: string}[];
  obfuscatedLeafHashes: string[];
  nonMaskable: string[];
  conformsTo: RecordConformsTo[];
  status: "draft" | "issuing" | "active" | "revoked" | "error";
  chain: {chainId?: number; contract?: string; txHash?: string; blockNumber?: number; blockTime?: Date};
}

export interface RecordExportFlowStore {
  getByToken(token: string): Promise<RecordExportSessionRow | null>;
  /** Atomically flips `usedAt` from unset to `now` - identical race-resolving contract to
   * `ExportFlowStore.tryConsume` (`lib/tags/exportFlow.ts`). */
  tryConsume(token: string, now: number): Promise<boolean>;
  /** The record that was active for `recordId` under exactly this `root` - `null` if it no longer
   * exists, or the root has since changed (a record's root is immutable once created - see
   * `RecordArtifact.ts`'s own header - so in practice this only ever misses on a deleted row). */
  findRecordByIdAndRoot(recordId: string, root: string): Promise<ExportedRecordRow | null>;
  findPetForExport(petId: string): Promise<{name: string} | null>;
  getClinicName(): Promise<string | undefined>;
}

export interface ExportableRecordField {
  keyPath: string;
  tag: number;
  value: string;
  /** Precomputed server-side, the same reason `lib/tags/exportFlow.ts`'s `ExportableField.leafHash`
   * is - so the "use client" field-picker component never imports `@dogtag/standard` directly. */
  leafHash: string;
  /** The plan's own non-negotiable, surfaced to the UI: `true` for one of the seven
   * `RECORD_NON_MASKABLE_KEY_PATHS` - the picker renders these as locked, not merely a checkbox
   * staff could uncheck and have the server refuse afterward. */
  locked: boolean;
}

/**
 * The staff-facing field-picker listing (plan section 11.2 V5) - every leaf on this record, each
 * with its precomputed leaf hash and whether it is locked non-maskable. Pure, no I/O - the route
 * wraps this around `findRecordArtifact`'s own leaves.
 */
export function listExportableRecordFields(leaves: {keyPath: string; saltHex: string; tag: number; value: string}[]): ExportableRecordField[] {
  const locked = new Set(RECORD_NON_MASKABLE_KEY_PATHS);
  return leaves.map((leaf) => ({
    keyPath: leaf.keyPath,
    tag: leaf.tag,
    value: leaf.value,
    leafHash: recomputeRecordLeafHash(leaf as OpenedLeaf),
    locked: locked.has(leaf.keyPath),
  }));
}

/** The RecordArtifact wire shape (`specs/vet-public-api.yaml`'s `ArtifactExportResponse`,
 * `artifactType: "record"` branch) - NEVER `dogTagIdField`/`dogTagIdDec`/`leaves`/`issuerClone` (a
 * record's dogTagId and issuer are disclosed LEAVES, not top-level fields), `reservedLeafHashes`
 * ALWAYS `[]`. `recordType`/`conformsTo`/`anchoring`/`presentation` are the record-only additions the
 * spec names - `presentation` is declared (optional, matching the spec's own "free-form, no
 * normative schema") but never populated by anything in this wave: no renderer hints exist yet
 * (WP4.11's dynamic renderer, the spec's own example, is a future wave) - the key is simply omitted
 * from every response this app serves today, which the spec's own optionality already permits. */
export interface RecordExportData {
  protocolVersion: string;
  artifactType: "record";
  schemaId: string;
  root: string;
  disclosed: OpenedLeaf[];
  obfuscatedLeafHashes: string[];
  reservedLeafHashes: [];
  recordType: string;
  conformsTo: RecordConformsTo[];
  anchoring: {chainId?: number; contract?: string; txHash?: string; blockNumber?: number; blockTime?: string};
  presentation?: Record<string, unknown>;
}

export type RecordExportResult =
  | {ok: true; data: RecordExportData & {petName: string; clinicName: string}}
  | {ok: false; code: "not_found"}
  | {ok: false; code: "expired_or_reused"}
  | {ok: false; code: "revoked"}
  | {ok: false; code: "internal_error"};

/**
 * Given a record (its full leaves plus whatever it already carries as opaque) and a set of
 * staff-picked keyPaths to mask, produces the exact `RecordArtifact`-shaped payload this app ever
 * serves for it - shared by the ceremony (`resolveAndConsumeRecordExport` below) and the staff-only
 * preview route, mirroring `lib/tags/exportFlow.ts`'s `buildRedactedExportPayload` structurally.
 *
 * Self-checks with `verifyRecordArtifact` before ever returning it. `mask` is assumed ALREADY
 * validated against `record.nonMaskable` by the caller (`validateRecordExportMask`) - this function
 * does not re-validate that itself, but `verifyRecordArtifact`'s own non-maskable check is a second,
 * independent backstop either way (fail-closed, never fail-open): a mask that slipped past the
 * pre-check (a server bug) still cannot produce a payload this function returns `ok: true` for.
 */
export function buildRecordExportPayload(
  record: Pick<ExportedRecordRow, "protocolVersion" | "schemaId" | "recordType" | "root" | "leaves" | "obfuscatedLeafHashes" | "conformsTo" | "chain">,
  mask: string[],
): {ok: true; data: RecordExportData} | {ok: false} {
  const maskedKeyPaths = new Set(mask);
  const disclosed = record.leaves.filter((l) => !maskedKeyPaths.has(l.keyPath)) as OpenedLeaf[];
  const newlyMaskedHashes = record.leaves.filter((l) => maskedKeyPaths.has(l.keyPath)).map((l) => recomputeRecordLeafHash(l as OpenedLeaf));
  const obfuscatedLeafHashes = [...record.obfuscatedLeafHashes, ...newlyMaskedHashes];

  const verifies = verifyRecordArtifact({
    protocolVersion: record.protocolVersion,
    artifactType: "record",
    schemaId: record.schemaId,
    root: record.root,
    disclosed,
    obfuscatedLeafHashes,
    reservedLeafHashes: [],
  });
  if (!verifies) return {ok: false};

  return {
    ok: true,
    data: {
      protocolVersion: record.protocolVersion,
      artifactType: "record",
      schemaId: record.schemaId,
      root: record.root,
      disclosed,
      obfuscatedLeafHashes,
      reservedLeafHashes: [],
      recordType: record.recordType,
      conformsTo: record.conformsTo,
      anchoring: {
        chainId: record.chain.chainId,
        contract: record.chain.contract,
        txHash: record.chain.txHash,
        blockNumber: record.chain.blockNumber,
        blockTime: record.chain.blockTime ? new Date(record.chain.blockTime).toISOString() : undefined,
      },
    },
  };
}

/**
 * `GET /e/:token` for a record session - mirrors `resolveAndConsumeExport`'s exact ordering
 * (not-found/expired pre-check, atomic consume, THEN look up the artifact, THEN check revocation,
 * THEN build+self-check the payload). No `superseded` outcome exists on this side - unlike a tag, a
 * record is never replaced by another (`RecordArtifact.ts`'s own header: "no supersedeActiveArtifactsForPet
 * equivalent"); the record this session was created for either still exists at this exact root
 * (records are immutable once created) or - the only realistic failure - has since been revoked.
 */
export async function resolveAndConsumeRecordExport(store: RecordExportFlowStore, token: string, now: number): Promise<RecordExportResult> {
  const session = await store.getByToken(token);
  if (!session) return {ok: false, code: "not_found"};
  if (session.usedAt !== undefined || now > session.exp) return {ok: false, code: "expired_or_reused"};

  const consumed = await store.tryConsume(token, now);
  if (!consumed) return {ok: false, code: "expired_or_reused"};

  const record = await store.findRecordByIdAndRoot(session.recordId, session.root);
  if (!record) return {ok: false, code: "not_found"};
  if (record.status === "revoked") return {ok: false, code: "revoked"};

  const built = buildRecordExportPayload(record, session.mask ?? []);
  if (!built.ok) {
    console.error(
      `record export self-check failed: the payload for recordId=${session.recordId} root=${record.root} did not recompute its own root (mask=${JSON.stringify(session.mask ?? [])}) - refusing to serve it.`,
    );
    return {ok: false, code: "internal_error"};
  }

  const pet = await store.findPetForExport(session.petId);
  const clinicName = await store.getClinicName();
  return {
    ok: true,
    data: {
      ...built.data,
      petName: pet?.name ?? "",
      clinicName: clinicName ?? "",
    },
  };
}
