import type {OpenedLeaf} from "@dogtag/standard";
import type {PetSex} from "@/lib/models/Pet";
import {
  resolveTagRootAndIssuer,
  verifyTagDataAgainstRoot,
  type TagDataChainDeps,
  type VerifiedPetAttributes,
} from "@/lib/tags/verifier";

/**
 * The pure import-ceremony flow (plans/wp4.9-tag-data-custody.md section 2.3) - the same
 * flow/store-adapter split every ceremony in this app uses. Two entry points, mirroring
 * `lib/registration/flow.ts`'s `resolveRegistrationChallenge` (`GET /i/:token`, non-consuming) +
 * `completeRegistration` (`POST /i/:token/complete`, consuming) shape exactly - unlike export,
 * which has no separate resolve/complete split because the phone only ever reads there, import's
 * phone-side submits data back, so it needs the two-step shape.
 */
export interface ImportSessionRow {
  token: string;
  /** Absent means "create a new pet from verified data" - set by STAFF at session-creation time,
   * never chosen by the scanning phone. */
  targetPetId?: string;
  clinicName: string;
  /** This clinic's own `VetIssuer` clone address, snapshotted at creation (lowercase) - the
   * "reclaim" check (`resolved.issuerClone === ourCloneAddress`) compares against THIS snapshot,
   * not a live re-read, mirroring every other snapshotted-at-creation field in this app's
   * ceremonies (`RegistrationSessionRow`'s own doc comment has the full rationale). */
  ourCloneAddress: string;
  exp: number;
  usedAt?: number;
}

export interface ImportTargetPetPreview {
  name: string;
  /** `Pet.dogTag.status === "active"` AND a tag actually exists - the plan's "target already has
   * an ACTIVE local tag" gate. This is a CHEAP, non-atomic read used two ways: `resolveImportSession`
   * surfaces it as display context, and `completeImport` uses it ONLY as an early-out optimization
   * (avoid a live chain read and burning the token for the common, non-racing case) - it is NEVER
   * the actual safety mechanism for the gate. See `AttachFlowStore.attachToExistingPet`'s own doc
   * comment for what actually enforces it. */
  hasActiveTag: boolean;
}

export interface ExistingPetAttributes {
  name?: string;
  species?: string;
  breed?: string;
  sex?: PetSex;
  dateOfBirth?: string;
}

export interface AttributeMergeField {
  field: "name" | "species" | "breed" | "sex" | "dateOfBirth";
  petValue: string;
  verifiedValue: string;
}

export interface AttachTagFields {
  dogTagIdDec?: string;
  dogTagIdField: string;
  root: string;
  issuerClone: string;
  /** `true` unless `issuerClone` equals this session's `ourCloneAddress` (the "reclaim" case) -
   * plan 2.3's exact rule for `Pet.dogTag.external`. Note this does NOT also drive the stored
   * TagArtifact's `source` - that field records ARRIVAL CHANNEL (did this come from the
   * custodial-bind terminal write, or from any import path), and a reclaimed tag still arrived via
   * this ceremony, never custodial-bind - so `source: "imported"` unconditionally for every
   * artifact this ceremony ever writes, reclaim or not (`lib/tags/artifact.ts`'s own header names
   * "the WP4.9 import ceremony" under the `imported` bucket without qualification). */
  external: boolean;
}

export type AttachToExistingPetResult = {ok: true; petName: string} | {ok: false};

export interface ImportFlowStore {
  getByToken(token: string): Promise<ImportSessionRow | null>;
  tryConsume(token: string, now: number): Promise<boolean>;
  previewTargetPet(petId: string): Promise<ImportTargetPetPreview | null>;
  findExistingPetAttributes(petId: string): Promise<ExistingPetAttributes | null>;
  /**
   * The REAL enforcement of "target already has an active local tag" - ONE atomic conditional
   * write (`Pet.findOneAndUpdate` matching only a pet with no tag yet OR a revoked one, mirroring
   * `appendWalletToClient`'s "one atomic round trip, no check-then-write window" precedent
   * exactly). Returns `{ok: false}` if it loses that match - either the pre-check in
   * `completeImport` was stale (a genuine race: another import/edit attached an active tag in the
   * interim), or the pre-check was skipped entirely - either way this is what actually prevents
   * two concurrent imports from both attaching to the same target.
   *
   * `resolvedAttributes` is the FULL post-merge picture (existing values, with any empty field
   * filled from `verified` - never a value that was already present, per the fill-empty-only
   * rule), not just the delta - the adapter $sets every field to its resolved value (idempotent
   * for anything that did not actually change) and recomputes `searchKey` from it in the same call.
   */
  attachToExistingPet(
    petId: string,
    resolvedAttributes: ExistingPetAttributes,
    tag: AttachTagFields,
    conflicts: AttributeMergeField[],
    now: number,
  ): Promise<AttachToExistingPetResult>;
  /** No conditional write needed - a brand new document has no prior state to race against. */
  createPetFromImport(attributes: ExistingPetAttributes, tag: AttachTagFields, now: number): Promise<{petId: string; petName: string}>;
  /** Wraps the shared `createTagArtifact` (`lib/tags/artifact.ts`) - throws on refusal (never
   * expected here: the leaves already passed the shared verifier's `verifyRedactedArtifact`
   * moments earlier) or on the root-belongs-to-a-different-pet invariant violation (a genuine, rare
   * race - two concurrent imports of the identical physical tag onto two different target pets -
   * left unhandled here the same way `lib/tags/artifact.ts`'s own doc comment already accepts for
   * its supersede-then-create crash window: a real but vanishingly rare operational scenario this
   * codebase already has an equivalent accepted risk class for, not a new one introduced here). */
  createImportedArtifact(input: {
    petId: string;
    dogTagIdDec?: string;
    dogTagIdField: string;
    root: string;
    issuerClone: string;
    leaves: OpenedLeaf[];
    /** WP4.10V item 6 - present (non-empty) only when the shared artifact being imported is
     * itself REDACTED (a masked share) - this clinic then stores honest PARTIAL custody: `leaves`
     * holds only what it actually received an opening for, this holds the rest as opaque hashes. */
    obfuscatedLeafHashes?: string[];
    reservedLeafHashes: string[];
    /** WP4.10V item 6 - threaded straight from the wire when the sender's export included one
     * (every artifact this app itself has ever exported does, since WP4.10V item 2/3) - never
     * invented when absent (an honest "unknown" beats a guessed schemaId). */
    schemaId?: string;
    now: number;
  }): Promise<void>;
}

export type ResolveImportResult =
  | {ok: true; clinicName: string; isNewPet: boolean; targetPetName?: string; ttlSecs: number}
  | {ok: false; code: "not_found"}
  | {ok: false; code: "expired_or_reused"};

/**
 * `GET /i/:token` - non-consuming (mirrors `resolveRegistrationChallenge`). Lets the owner's app
 * show a confirmation screen ("You're about to send your tag's data to <clinicName>, for <target>")
 * before the owner ever submits anything.
 */
export async function resolveImportSession(store: ImportFlowStore, token: string, now: number): Promise<ResolveImportResult> {
  const session = await store.getByToken(token);
  if (!session) return {ok: false, code: "not_found"};
  if (session.usedAt !== undefined || now > session.exp) return {ok: false, code: "expired_or_reused"};

  if (!session.targetPetId) {
    return {ok: true, clinicName: session.clinicName, isNewPet: true, ttlSecs: session.exp - now};
  }
  const target = await store.previewTargetPet(session.targetPetId);
  return {ok: true, clinicName: session.clinicName, isNewPet: false, targetPetName: target?.name, ttlSecs: session.exp - now};
}

export interface CompleteImportInput {
  token: string;
  dogTagIdDec?: string;
  dogTagIdField?: string;
  leaves: OpenedLeaf[];
  /** WP4.10V item 6 - present when the owner's share was itself a REDACTED (masked) artifact.
   * Absent/empty is the pre-WP4.10V shape: an ordinary, fully-disclosed import. */
  obfuscatedLeafHashes?: string[];
  reservedLeafHashes: string[];
  /** WP4.10V item 6 - the sender's own `schemaId`, when their export included one. */
  schemaId?: string;
}

export type CompleteImportResult =
  | {ok: true; petId: string; petName: string; created: boolean; conflicts: AttributeMergeField[]}
  | {ok: false; code: "not_found"}
  | {ok: false; code: "expired_or_reused"}
  | {ok: false; code: "malformed_claim"}
  | {ok: false; code: "chain_unreadable"}
  | {ok: false; code: "root_unset"}
  | {ok: false; code: "revoked"}
  | {ok: false; code: "verify_failed"}
  | {ok: false; code: "already_has_active_tag"};

/**
 * The FILL-EMPTY-ONLY attribute merge (plan 2.3: "never overwrite staff-entered [data]") - pure,
 * no I/O. For each field: empty on the target -> fill it from the verified claim; both present and
 * EQUAL -> already agrees, nothing to record; both present and DIFFERENT -> a conflict (the
 * target's own value is kept, the verified value is surfaced for the pet-page banner, never
 * applied). Exact string equality throughout, matching this codebase's existing lack of
 * fuzzy-matching anywhere else (species/breed/dateOfBirth are all plain strings with no
 * normalization layer today).
 */
export function mergeVerifiedAttributes(
  existing: ExistingPetAttributes,
  verified: VerifiedPetAttributes,
): {resolved: ExistingPetAttributes; conflicts: AttributeMergeField[]} {
  const fields = ["name", "species", "breed", "sex", "dateOfBirth"] as const;
  const resolved: ExistingPetAttributes = {...existing};
  const conflicts: AttributeMergeField[] = [];
  for (const field of fields) {
    const verifiedValue = verified[field];
    if (verifiedValue === undefined) continue;
    const petValue = existing[field];
    if (!petValue) {
      (resolved as Record<string, string>)[field] = verifiedValue;
    } else if (petValue !== verifiedValue) {
      conflicts.push({field, petValue, verifiedValue});
    }
  }
  return {resolved, conflicts};
}

/**
 * `POST /i/:token/complete` - consumes the token on EVERY outcome, success or refusal (mirrors
 * `completeRegistration`'s `signature_invalid` precedent: any check needing a fresh per-attempt
 * read, rather than one already decidable from the token row alone, is one-shot by design,
 * uniform regardless of WHY a given attempt failed - see `resolveAndConsumeExport`'s identical
 * reasoning for the sibling ceremony). `chain_unreadable` still burns the token even though the
 * owner did nothing wrong and the tag itself may be perfectly fine - the response copy for this
 * one code says "generate a new code and try again", never anything implying the tag failed
 * verification, so the ceremony's honesty stays intact even though its one-shot-ness does not bend
 * for this case.
 *
 * Gate order:
 * 1. Token not-found / cheap expired-or-used pre-check (before consuming).
 * 2. CHEAP early-out via `previewTargetPet.hasActiveTag` when a target was named - an
 *    optimization only (skips a live chain read and avoids burning the token for the overwhelmingly
 *    common non-race case), NEVER the actual safety mechanism - see `hasActiveTag`'s own doc
 *    comment. Still before consuming, since this is "already known to be doomed" in the same sense
 *    the token-state pre-check is.
 * 3. Atomically consume.
 * 4. The shared verifier (`lib/tags/verifier.ts`, plan 2.3/item 4, generalized by WP4.10V item 6) -
 *    dec/field consistency, `profileRoot`, `rootIssuer`, then `isValid`/`verifyRedactedArtifact`
 *    (accepting `obfuscatedLeafHashes` when the sender's own share was itself redacted - a claim
 *    with none verifies identically to the pre-WP4.10V shape). `root` is NEVER client-supplied -
 *    always the live on-chain read for `dogTagIdField`, which is exactly what makes "a replaced
 *    root imports as its current self" and "reinstated-later succeeds on a fresh scan" true for
 *    free: this always checks the CURRENT chain state, never a cached one.
 * 5. For an existing-pet target: the ATOMIC conditional attach (`attachToExistingPet`) is the
 *    REAL enforcement of "no active tag already" - attach the pet BEFORE calling
 *    `createTagArtifact` below, so a lost race here never supersedes a live artifact for an import
 *    that didn't land (mirrors `runSideEffects`'s own create/link-before-artifact ordering).
 * 6. `createImportedArtifact` - `source: "imported"` always (see `AttachTagFields.external`'s own
 *    doc comment for why `source` does not vary with the reclaim case).
 */
export async function completeImport(
  store: ImportFlowStore,
  deps: TagDataChainDeps,
  input: CompleteImportInput,
  now: number,
): Promise<CompleteImportResult> {
  const session = await store.getByToken(input.token);
  if (!session) return {ok: false, code: "not_found"};
  if (session.usedAt !== undefined || now > session.exp) return {ok: false, code: "expired_or_reused"};

  if (session.targetPetId) {
    const preview = await store.previewTargetPet(session.targetPetId);
    if (preview?.hasActiveTag) return {ok: false, code: "already_has_active_tag"};
  }

  const consumed = await store.tryConsume(input.token, now);
  if (!consumed) return {ok: false, code: "expired_or_reused"};

  const resolved = await resolveTagRootAndIssuer(deps, {dogTagIdDec: input.dogTagIdDec, dogTagIdField: input.dogTagIdField});
  if (!resolved.ok) {
    if (resolved.reason === "malformed_claim") return {ok: false, code: "malformed_claim"};
    if (resolved.reason === "root_unset") return {ok: false, code: "root_unset"};
    return {ok: false, code: "chain_unreadable"}; // chain_unreadable | issuer_unknown
  }

  const dataResult = await verifyTagDataAgainstRoot(deps, {
    issuerClone: resolved.issuerClone,
    root: resolved.root,
    dogTagIdField: resolved.dogTagIdField,
    leaves: input.leaves,
    obfuscatedLeafHashes: input.obfuscatedLeafHashes,
    reservedLeafHashes: input.reservedLeafHashes,
  });
  if (!dataResult.ok) return {ok: false, code: "chain_unreadable"};
  if (!dataResult.issuerValid) return {ok: false, code: "revoked"};
  if (!dataResult.dataVerified) return {ok: false, code: "verify_failed"};

  const isReclaim = resolved.issuerClone === session.ourCloneAddress.toLowerCase();
  const verifiedAttrs = dataResult.verifiedAttributes ?? {};
  const tagFields: AttachTagFields = {
    dogTagIdDec: input.dogTagIdDec,
    dogTagIdField: resolved.dogTagIdField,
    root: resolved.root,
    issuerClone: resolved.issuerClone,
    external: !isReclaim,
  };

  let petId: string;
  let petName: string;
  let created: boolean;
  let conflicts: AttributeMergeField[] = [];

  if (session.targetPetId) {
    const existing = (await store.findExistingPetAttributes(session.targetPetId)) ?? {};
    const merge = mergeVerifiedAttributes(existing, verifiedAttrs);
    const attached = await store.attachToExistingPet(session.targetPetId, merge.resolved, tagFields, merge.conflicts, now);
    if (!attached.ok) return {ok: false, code: "already_has_active_tag"};
    petId = session.targetPetId;
    petName = attached.petName;
    created = false;
    conflicts = merge.conflicts;
  } else {
    const createdPet = await store.createPetFromImport(verifiedAttrs, tagFields, now);
    petId = createdPet.petId;
    petName = createdPet.petName;
    created = true;
  }

  await store.createImportedArtifact({
    petId,
    dogTagIdDec: input.dogTagIdDec,
    dogTagIdField: resolved.dogTagIdField,
    root: resolved.root,
    issuerClone: resolved.issuerClone,
    leaves: input.leaves,
    obfuscatedLeafHashes: input.obfuscatedLeafHashes,
    reservedLeafHashes: input.reservedLeafHashes,
    schemaId: input.schemaId,
    now,
  });

  return {ok: true, petId, petName, created, conflicts};
}
