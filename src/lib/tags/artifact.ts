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
  /**
   * Default `true`. `false` is for exactly ONE caller: the custodial-bind terminal write
   * (`lib/tags/issuedArtifactSideEffect.ts`) - see this function's own doc comment (WP4.9V FIX
   * ROUND 1, D3) for why an `issued_here` artifact must not be born active. Every other caller
   * (the WP4.4 booking tier-4 import side effect, the WP4.9 import ceremony, the backfill script)
   * verifies the root against a LIVE chain read in the same request that creates the artifact, so
   * `active` immediately is correct for them - there is no separate "confirm" step still to come.
   */
  activate?: boolean;
}

export type CreateTagArtifactResult =
  | {
      ok: true;
      artifact: TagArtifactDoc;
      /** `true` when this call found an existing, already-verified row for (petId, root) that was
       * `active: false` and promoted it back to `active` rather than inserting a new one - see the
       * "repair" branch in this function's own doc comment (WP4.9V FIX ROUND 1, D1). `false` for
       * both a genuinely fresh insert and the ordinary already-active idempotent return. */
      reactivated: boolean;
    }
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
 * the pet's previous artifact exactly as active as it was).
 *
 * `active` at CREATE time is `input.activate ?? true` (see that field's own doc comment) - only
 * when `true` does this call also supersede the pet's other active rows first, in the same request.
 * WP4.9V FIX ROUND 1 (D3): custodial-bind creates its `issued_here` artifact strictly BEFORE the
 * on-chain `issueTag` (`lib/mint/flow.ts`'s `custodialBind` only checks the slot is still UNSET,
 * never that THIS root is anchored) - promoting it to `active` and superseding the pet's real,
 * anchored tag at that moment would let a reissue whose `issueTag` later reverts or is abandoned
 * leave the pet's "active" custody record on a root that was never anchored, and the export
 * ceremony would disclose it. So custodial-bind passes `activate: false`: this artifact is created
 * but inert until the terminal confirm write (`lib/mint/reconcile.ts::linkPetDogTag`, via
 * `activateAnchoredArtifact` below) promotes it - exactly when the chain confirms the root, never
 * before. Every OTHER caller (WP4.4 booking tier-4, the WP4.9 import ceremony, the backfill script)
 * already re-read the chain live in this same request, so `activate: true` (the default) is correct
 * for them - there is no separate confirm step still to come.
 *
 * WP4.9V FIX ROUND 1 (D1): a repeat call naming a (petId, root) pair that already has a row, but
 * one that is currently `active: false`, is treated as a REPAIR, not a no-op - see the `existing`
 * branch below. A caller only ever calls `createTagArtifact` (directly, or via the backfill script)
 * for a root it believes IS this pet's current one, so reactivating on an exact match is always
 * correct: it closes the one window this repo's transactionless-writes house style (no `mongoose`
 * session/transaction use anywhere in this app) cannot otherwise close - if a PRIOR call died
 * between its own supersede and create/activate step, the pet is left with zero active artifacts
 * and an inactive row sitting on exactly the root that should be active. The backfill script (item
 * 3c) is this window's actual safety net, and now genuinely converges: it calls this function again
 * for the pet's `dogTag.root`, which hits this repair branch and reactivates rather than reporting
 * `inserted` forever.
 *
 * WP4.9V FIX ROUND 2 (N2): the repair branch above only fires when `input.activate ?? true` is
 * true. A caller that explicitly passes `activate: false` (today, only `mongoIssuedArtifactStore`'s
 * custodial-bind write) must never be the thing that promotes an un-anchored artifact, even when it
 * happens to name a root that already has an inactive row on file - `activateAnchoredArtifact` is
 * the only promoter, exactly the invariant the rest of this D3 fix depends on. This path is latent
 * today (no caller can currently reach it - see wp4.9V-progress.md's FIX ROUND 2 log for the
 * reachability analysis) but is one line to close and the whole custody model rests on it.
 *
 * IDEMPOTENT on a repeated call for the SAME (petId, root) that is ALREADY active: returns the
 * already-stored row rather than attempting a second insert against the unique `root` index. This
 * is load-bearing for more than one caller, not a defensive nicety - the WP4.4 booking side
 * effect's own dedupe path (`findExternalPetByDogTagField`, reusing an already-imported external
 * pet on a repeat booking with the same tag) and the backfill script's own "safe to re-run"
 * requirement both depend on a second call for a tag already on file being a harmless no-op, never
 * a thrown duplicate-key error. A root that already belongs to a DIFFERENT pet, however, is never
 * silently accepted - two distinct pets computing the identical root should be cryptographically
 * impossible, so that case still throws (a genuine invariant violation the caller's own try/catch
 * surfaces as a failure, never swallowed here).
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
    if (!existing.active) {
      if (!(input.activate ?? true)) {
        // WP4.9V FIX ROUND 2 (N2) - a caller that explicitly declines activation must never be the
        // thing that promotes an un-anchored artifact, even on a repeat call for a root that already
        // has an inactive row on file. `activateAnchoredArtifact` is the only promoter.
        return {ok: true, artifact: existing, reactivated: false};
      }
      // Repair path (D1) - see this function's own doc comment. Defensively supersede first (in
      // case some OTHER row for this pet is somehow also active - the bad-data state
      // `supersedeActiveArtifactsForPet`'s own doc comment already tolerates), then promote this
      // exact row.
      await supersedeActiveArtifactsForPet(input.petId, normalizedRoot);
      const reactivated = await TagArtifact.findOneAndUpdate(
        {root: normalizedRoot},
        {$set: {active: true}, $unset: {supersededByRoot: ""}},
        {new: true},
      ).lean<TagArtifactDoc>();
      return {ok: true, artifact: reactivated!, reactivated: true};
    }
    return {ok: true, artifact: existing, reactivated: false};
  }

  const activate = input.activate ?? true;
  if (activate) {
    await supersedeActiveArtifactsForPet(input.petId, input.root);
  }

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
    active: activate,
  });
  return {ok: true, artifact: created.toObject(), reactivated: false};
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

/**
 * WP4.9V FIX ROUND 1 (D3) - the ONLY place a `source: "issued_here"` artifact is ever promoted to
 * `active`. Called from `lib/mint/reconcile.ts::linkPetDogTag` - the ONE terminal write every
 * anchor-confirming path in this app already funnels through (the mint confirm route, the retry
 * route, the worker's boot recovery, and WP4.4 tier-3's staff relink all call `linkPetDogTag`), so
 * this is also the one place custody is ever promoted, exactly when the chain confirms the root -
 * never at custodial-bind time, before `issueTag` has even been sent (see `createTagArtifact`'s own
 * doc comment for the full "anchor vs bind" reasoning).
 *
 * Defensive no-op when no artifact row exists yet for this exact (petId, root) - `linkPetDogTag` is
 * also the write path for a legacy pre-WP4.9 pet (no backfill run yet) and for WP4.4 tier-3's relink
 * (a tag this clinic issued that a database restore disconnected from any local Pet, which may
 * predate this app's own `TagArtifact` collection entirely).
 *
 * This function itself can still throw (a genuine Mongo failure on either write below) - WP4.9V FIX
 * ROUND 2 (N1): the "never throw" guarantee this doc comment used to claim here is actually enforced
 * one layer up, by `linkPetDogTag`'s own try/catch around this call. Every one of `linkPetDogTag`'s
 * callers already treats its own write as complete regardless of this side effect's outcome -
 * throwing past `linkPetDogTag` would turn a genuine on-chain confirmation into a failed response,
 * exactly the failure mode `applyIssuedArtifactSideEffect`'s own "never throw" contract exists to
 * avoid one layer up. The backfill script's REACTIVATE repair (`scripts/backfillTagArtifacts.ts`,
 * run manually with `--write`) is the documented repair path for a pet this leaves without a
 * matching active artifact.
 *
 * Also a no-op (never re-supersedes) when the named artifact is ALREADY `active` - idempotent for
 * the worker boot recovery re-confirming an already-`bound` session, or a retried confirm call.
 */
export async function activateAnchoredArtifact(petId: string, root: string): Promise<{activated: boolean}> {
  const normalizedRoot = root.toLowerCase();
  const artifact = await TagArtifact.findOne({petId, root: normalizedRoot}).lean<TagArtifactDoc>();
  if (!artifact || artifact.active) return {activated: false};

  await supersedeActiveArtifactsForPet(petId, normalizedRoot);
  await TagArtifact.updateOne({petId, root: normalizedRoot}, {$set: {active: true}, $unset: {supersededByRoot: ""}});
  return {activated: true};
}
