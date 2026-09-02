import "server-only";
import {verifyLeafCommitment, type OpenedLeaf, type VerifyLeafCommitmentInput} from "@dogtag/standard";
import {TagArtifact, type TagArtifactDoc, type TagArtifactLeaf, type TagArtifactSource} from "@/lib/models/TagArtifact";

/**
 * The ONE write path onto `TagArtifact` (plan section 2.1's invariant): "no artifact row is ever
 * inserted without `verifyLeafCommitment` passing right there." Every caller - the custodial-bind
 * terminal write (issued_here), the WP4.4 booking tier-4 import side effect (imported), and the
 * WP4.9 import ceremony (imported) - goes through `createTagArtifact`, never `TagArtifact.create`
 * directly.
 *
 * `PROTOCOL_VERIFIERS` is "the standard way to recompute the root from stored data, dispatched by
 * protocolVersion" (plan 2.1): today it has exactly one entry, because exactly one protocol version
 * exists (`dogtag-v2/1` - crypto is frozen, see leaf-commitment.md section 12). An artifact whose
 * `protocolVersion` is not in this table is refused, never silently accepted under the current
 * verifier - this is what makes the dispatch a REAL gate rather than decoration: a future `v3`
 * artifact needs a new entry here before this function will ever store one.
 */
const PROTOCOL_VERIFIERS: Record<string, (input: VerifyLeafCommitmentInput) => boolean> = {
  "dogtag-v2/1": verifyLeafCommitment,
};

export interface CreateTagArtifactInput {
  petId: string;
  /** Optional - see `TagArtifactDoc.dogTagIdDec`'s own doc comment. */
  dogTagIdDec?: string;
  /** Decimal-string convention throughout this app - see TagArtifact.ts's own doc comment. */
  dogTagIdField: string;
  root: string;
  protocolVersion: string;
  schemaId?: string;
  leaves: OpenedLeaf[];
  reservedLeafHashes: string[];
  /** The `owner.identity.*` cross-check `verifyLeafCommitment` requires. For `issued_here`, this is
   * the vet's own attested identity leaves (`MintSessionRow.identityLeaves`) - a REAL cross-check.
   * For `imported` (both the WP4.4 booking path and the WP4.9 import ceremony), there is no
   * vet-attested record to check against, so callers pass the disclosed `owner.identity.*` subset
   * of `leaves` itself - the same deliberate self-check no-op `lib/tags/verifier.ts`'s
   * `verifyTagDataAgainstRoot` already documents, kept consistent here. */
  expectedIdentityLeaves: OpenedLeaf[];
  source: TagArtifactSource;
  issuerClone: string;
  issuedTx?: string;
  /** Unix seconds "now" - stamped as `verifiedAt` only once `verified` below is confirmed true,
   * never the caller's own claim about when ITS check ran. */
  now: number;
}

export type CreateTagArtifactResult =
  | {ok: true; artifact: TagArtifactDoc}
  | {ok: false; reason: "leaf_commitment_invalid"}
  | {ok: false; reason: "unsupported_protocol_version"};

function toArtifactLeaves(leaves: OpenedLeaf[]): TagArtifactLeaf[] {
  return leaves.map((l) => ({keyPath: l.keyPath, saltHex: l.saltHex, tag: l.tag, value: l.value}));
}

export type VerifyForProtocolVersionResult = {ok: true} | {ok: false; reason: "leaf_commitment_invalid" | "unsupported_protocol_version"};

/**
 * The pure verify-only half of `createTagArtifact` - no I/O, dispatched by `protocolVersion` exactly
 * like the write path. Exported so the backfill script's dry-run mode (`lib/tags/backfill.ts`) can
 * report exactly what `createTagArtifact` would decide WITHOUT writing anything - a real, byte-for-
 * byte-identical prediction rather than a second, separately-maintained copy of this dispatch.
 */
export function verifyForProtocolVersion(input: VerifyLeafCommitmentInput & {protocolVersion: string}): VerifyForProtocolVersionResult {
  const verifier = PROTOCOL_VERIFIERS[input.protocolVersion];
  if (!verifier) return {ok: false, reason: "unsupported_protocol_version"};
  return verifier(input) ? {ok: true} : {ok: false, reason: "leaf_commitment_invalid"};
}

/**
 * Verify-then-insert, in that order, with NO write happening before verification passes (so a
 * refused insert never touches `supersedeActiveArtifactsForPet` either - a failed reissue leaves
 * the pet's previous artifact exactly as active as it was). Supersede-then-create (not the reverse)
 * is a deliberate ordering choice for the ONE window this repo's transactionless-writes house style
 * (no `mongoose` session/transaction use anywhere in this app) cannot close: if the process dies
 * between the supersede and the create below, the pet is briefly left with ZERO active artifacts
 * rather than two. Zero active is the safer failure shape for every reader of "the pet's active
 * artifact" (`findOne({petId, active: true})` - the export ceremony, the backfill idempotence
 * check): it fails closed and visibly ("no active tag data"), whereas two actives would let a
 * `findOne` non-deterministically prefer either the old or the new row. The backfill script (item
 * 3c) is this window's actual safety net - safe to re-run, and idempotent exactly because it looks
 * for "a pet whose `dogTag.root` has no matching active artifact yet", which this crash state is.
 *
 * IDEMPOTENT on a repeated call for the SAME (petId, root): returns the already-stored row rather
 * than attempting a second insert against the unique `root` index. This is load-bearing for more
 * than one caller, not a defensive nicety - the WP4.4 booking side effect's own dedupe path
 * (`findExternalPetByDogTagField`, reusing an already-imported external pet on a repeat booking
 * with the same tag) and the backfill script's own "safe to re-run" requirement both depend on a
 * second call for a tag already on file being a harmless no-op, never a thrown duplicate-key error.
 * A root that already belongs to a DIFFERENT pet, however, is never silently accepted - two
 * distinct pets computing the identical root should be cryptographically impossible, so that case
 * still throws (a genuine invariant violation the caller's own try/catch surfaces as a failure,
 * never swallowed here).
 */
export async function createTagArtifact(input: CreateTagArtifactInput): Promise<CreateTagArtifactResult> {
  const verified = verifyForProtocolVersion({
    protocolVersion: input.protocolVersion,
    root: input.root,
    leaves: input.leaves,
    reservedLeafHashes: input.reservedLeafHashes,
    expectedIdentityLeaves: input.expectedIdentityLeaves,
  });
  if (!verified.ok) return verified;

  const normalizedRoot = input.root.toLowerCase();
  const existing = await TagArtifact.findOne({root: normalizedRoot}).lean<TagArtifactDoc>();
  if (existing) {
    if (existing.petId !== input.petId) {
      throw new Error(
        `TagArtifact root ${normalizedRoot} already belongs to pet ${existing.petId}; refusing to also attach it to ${input.petId}`,
      );
    }
    return {ok: true, artifact: existing};
  }

  await supersedeActiveArtifactsForPet(input.petId, input.root);

  const created = await TagArtifact.create({
    petId: input.petId,
    dogTagIdDec: input.dogTagIdDec,
    dogTagIdField: input.dogTagIdField,
    root: normalizedRoot,
    protocolVersion: input.protocolVersion,
    schemaId: input.schemaId,
    leaves: toArtifactLeaves(input.leaves),
    reservedLeafHashes: input.reservedLeafHashes,
    source: input.source,
    issuerClone: input.issuerClone.toLowerCase(),
    issuedTx: input.issuedTx,
    verifiedAt: input.now,
    active: true,
  });
  return {ok: true, artifact: created.toObject()};
}

/**
 * Flips EVERY currently-active artifact for `petId` to `active: false, supersededByRoot: newRoot`
 * - `updateMany`, not "the" single active row, so this has defined, safe behavior even if a pet
 * somehow already has more than one active row (bad data from before this invariant existed, or a
 * hand-repaired document) rather than assuming exactly one and leaving a second one live. A no-op
 * (matches zero documents) for a pet's first-ever tag - never an error.
 */
export async function supersedeActiveArtifactsForPet(petId: string, newRoot: string): Promise<void> {
  await TagArtifact.updateMany({petId, active: true}, {$set: {active: false, supersededByRoot: newRoot.toLowerCase()}});
}

/** The pet's current custody record, or `null` if it has none (never issued/imported here yet, or
 * a backfill/repair gap - see `createTagArtifact`'s own doc comment on the zero-active window). */
export async function findActiveTagArtifact(petId: string): Promise<TagArtifactDoc | null> {
  return TagArtifact.findOne({petId, active: true}).lean<TagArtifactDoc>();
}
