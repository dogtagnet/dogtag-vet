import type {OpenedLeaf} from "@dogtag/standard";
import type {BookingIdentity} from "@/lib/models/Appointment";
import {
  resolveTagRootAndIssuer,
  verifyTagDataAgainstRoot,
  mapVerifiedLeavesToPetAttributes,
  type TagDataChainDeps,
  type VerifiedPetAttributes,
} from "@/lib/tags/verifier";

// Re-exported so every existing import of these two names from THIS module (this repo's own
// `tests/unit/booking/mobileReconcile.test.ts` included - it is WP4.4's parity proof and must keep
// compiling and passing completely unmodified) keeps resolving, even though both now live in
// `lib/tags/verifier.ts` (plan section 2.3's shared-verifier extraction, used by both this file's
// tier 4 and the WP4.9 import ceremony).
export {mapVerifiedLeavesToPetAttributes, type VerifiedPetAttributes};

/** The wire's `bookingIdentity.tagResolution` enum - plans/wp4.4-mobile-booking-protocol.md
 * section 1 (normative, LOCKED). */
export type TagResolution = "local" | "issued_here_unlinked" | "external" | "unknown" | "none";

export interface LocalPetMatch {
  petId: string;
  /** Review finding 3: carried through to the CLEAN-match `TagClaimResult` variant so the booking
   * route can rebuild `Appointment.petName` from the actually-linked pet rather than leaving
   * whatever display placeholder the wire's own (unverified) `mobile.pet.name` or the request's
   * `petName` asserted - the same WP4.3 "no display-name drift from the linked record" invariant
   * `relink-dogtag`'s own write already follows (`petName: pet.name`). Never read for the
   * ownership-mismatch (`needsReview: true`) variant - that pet is deliberately NOT linked, so
   * there is no name to adopt. */
  name: string;
  ownerClientIds: string[];
}

/** The reads `resolveTagClaim` needs from the local database - injected so the tier-resolution
 * decision logic below is unit-testable with an in-memory fake, the same "flow/store-adapter"
 * pattern `lib/booking/book.ts`'s `BookingStore` and `lib/mint/flow.ts`'s `MintFlowStore` already
 * use. Read-only by design: `resolveTagClaim` makes zero writes (see its own doc comment for why -
 * a provisional pet is created by the CALLER only after the appointment itself is durably
 * inserted, never here). */
export interface MobileTagLookupStore {
  /** Indexed lookup on `Pet.dogTag.dogTagIdDec`/`dogTagIdField` - tier 1. */
  findLocalPetByDogTag(input: {dogTagIdDec?: string; dogTagIdField?: string}): Promise<LocalPetMatch | null>;
  /** Is there already a provisional (`external: true`) pet imported for this exact
   * `dogTagIdField`? A read-only dedupe HINT for the caller - `resolveTagClaim` itself never
   * creates or links anything - so a client who books repeatedly with the same foreign tag gets
   * the same pet record reused rather than a fresh duplicate on every visit. Only ever consulted
   * once data verification (Q3) has actually passed - see `resolveTagClaim`'s doc comment. */
  findExternalPetByDogTagField(dogTagIdFieldDec: string): Promise<{petId: string} | null>;
}

/** Fail-closed chain reads `resolveTagClaim` needs - now `lib/tags/verifier.ts`'s
 * `TagDataChainDeps` (the shared-verifier extraction), re-exported under this file's own
 * established name so `lib/booking/mobileMongoAdapters.ts`'s `mongoMobileTagChainDeps`/
 * `unconfiguredMobileTagChainDeps` and every test importing `MobileTagChainDeps` FROM THIS MODULE
 * need zero changes. Every method is allowed to THROW (an unreachable RPC, per every other reader
 * in this app) - `resolveTagClaim` catches every one of these (via the two shared-verifier calls
 * below) and folds a failure into `{tagResolution: "unknown", verificationError: true}` rather than
 * propagating, so a chain hiccup degrades the TAG CLAIM only and never loses the booking itself. */
export type MobileTagChainDeps = TagDataChainDeps;

export interface TagClaimInput {
  dogTagIdDec?: string;
  /** When absent, derived from `dogTagIdDec` via `@dogtag/standard`'s `dogTagIdField` (no chain
   * read - pure computation, per section 3.2). */
  dogTagIdField?: string;
  /** The client THIS booking resolved to (wallet-match-first, else email/phone, else create) -
   * tier 1's ownership consistency check compares this against the matched pet's own
   * `ownerClientIds`. */
  resolvedClientId: string;
  /** This clinic's own `VetIssuer` clone address (`ClinicSettings.cloneAddress`), lowercase or
   * not - compared case-insensitively against `readRootIssuer`'s result. */
  ourCloneAddress: string;
  /** Q3 level-2 verification data - the pet's FULL opened profile-tree leaves (every leaf the
   * original bind disclosed, not a selective subset - `verifyLeafCommitment` has no concept of
   * partial/obfuscated disclosure) plus the 3 reserved owner-control leaf hashes. Both fields
   * absent (or empty) means "no data sent" - a legitimate, common shape, not an error. */
  leaves?: OpenedLeaf[];
  reservedLeafHashes?: string[];
}

export type TagClaimResult =
  | {tagResolution: "none"}
  | {tagResolution: "local"; petId: string; name: string; needsReview: false}
  /** Tier 1's ownership-mismatch guard (hijack prevention): a LOCAL pet was found for the claimed
   * dogTagId, but the client this booking resolved to is NOT among that pet's `ownerClientIds`.
   * The pet is deliberately NOT linked (`appointmentTagging.ts`'s `resolveTagging` treats "every
   * tagged pet's ownerClientIds contains the tagged clientId" as an invariant every OTHER write
   * path enforces - auto-linking here would write an appointment no staff Edit-tagging save could
   * ever re-validate). `candidatePetId` is surfaced so the provenance box can point staff at the
   * pet the claim named, for them to resolve manually. */
  | {tagResolution: "local"; needsReview: true; candidatePetId: string}
  /** Either the root is genuinely unset on chain (`verificationError: false`), or a chain read
   * failed transiently and this claim could not be checked at all (`verificationError: true`) -
   * both fold to the SAME locked wire enum value, but the box shows different copy for each. */
  | {tagResolution: "unknown"; verificationError: boolean}
  | {tagResolution: "issued_here_unlinked"; issuerClone: string; dogTagIdField: string; root: string}
  | {
      tagResolution: "external";
      issuerClone: string;
      dogTagIdField: string;
      root: string;
      /** `VetIssuer.isValid(root)` against the issuer clone - a `false` here means a revoked (or
       * otherwise invalid) but genuinely-issued-elsewhere tag; still reported as `"external"` (an
       * issuer WAS identified), just never eligible for Q3 import. */
      issuerValid: boolean;
      /** Did the request carry BOTH `leaves` and `reservedLeafHashes` (non-empty)? Distinguishes
       * "no data sent" from "data sent but rejected" - both fall back to appointment-only per Q3,
       * but the box's copy differs. */
      dataVerificationAttempted: boolean;
      /** Q3's full gate: `issuerValid && dataVerificationAttempted &&` the sent leaves recompute
       * (via the SAME `verifyLeafCommitment` the custodial-bind flow uses) to the on-chain root
       * read above. Only when this is `true` does the caller import a provisional pet record. */
      dataVerified: boolean;
      /** Present only when `dataVerified` - the caller uses this to populate the imported pet's
       * attributes. Never computed when verification did not pass: an attribute pulled from an
       * UNverified leaf set is not a verified attribute. */
      verifiedAttributes?: VerifiedPetAttributes;
      /** Present only when `dataVerified` AND a pet already exists for this exact
       * `dogTagIdField` marked `external: true` - the caller reuses it instead of importing a
       * duplicate. */
      existingExternalPetId?: string;
    };

/**
 * Tag claim resolution - plans/wp4.4-mobile-booking-protocol.md section 3, tiers 1-4 (normative,
 * LOCKED). Zero writes: this function only READS (the injected store and chain deps) and performs
 * pure local computation; the caller creates/links a provisional pet only AFTER the appointment
 * itself is durably inserted (avoids an orphaned provisional Pet if the booking itself then loses a
 * slot-capacity race - see the booking route's own doc comment).
 *
 * Tiers 2-4 (dec<->field consistency, `profileRoot`, `rootIssuer`, `isValid`, `verifyLeafCommitment`)
 * are `lib/tags/verifier.ts`'s shared verifier (plan section 2.3) - see that module's own doc
 * comment for exactly why it is two functions, not one, and why the split boundary sits precisely
 * where tier 3's `issued_here_unlinked` short-circuit needs it to.
 *
 * Every chain read is wrapped so a transient RPC failure can NEVER lose the booking (Q2's
 * "invalid signature rejects the whole booking" is about the SIGNATURE, a pure local check with no
 * I/O - it does not extend to "an unreadable chain rejects the booking": an unresolvable tag claim
 * always falls back to `"unknown"`, keeping the appointment, exactly like `reconcileAnchoredSession`
 * (`lib/mint/reconcile.ts`) treats an unreadable chain as "leave it alone", never as "definitely
 * false").
 */
export async function resolveTagClaim(
  store: MobileTagLookupStore,
  deps: MobileTagChainDeps,
  input: TagClaimInput,
): Promise<TagClaimResult> {
  if (!input.dogTagIdDec && !input.dogTagIdField) {
    return {tagResolution: "none"};
  }

  // Tier 1: LOCAL indexed lookup - never touches the chain at all.
  const local = await store.findLocalPetByDogTag({dogTagIdDec: input.dogTagIdDec, dogTagIdField: input.dogTagIdField});
  if (local) {
    if (local.ownerClientIds.includes(input.resolvedClientId)) {
      return {tagResolution: "local", petId: local.petId, name: local.name, needsReview: false};
    }
    return {tagResolution: "local", needsReview: true, candidatePetId: local.petId};
  }

  // Tier 2/3: NOT local -> shared verifier stage 1 (dec<->field, profileRoot, rootIssuer).
  const resolved = await resolveTagRootAndIssuer(deps, {dogTagIdDec: input.dogTagIdDec, dogTagIdField: input.dogTagIdField});
  if (!resolved.ok) {
    // `root_unset` is the one reason that means "chain read fine, nothing issued" rather than
    // "could not check" - every other reason is a claim/chain problem, per verifier.ts's own doc
    // comment on `RootIssuerResolution`.
    return {tagResolution: "unknown", verificationError: resolved.reason !== "root_unset"};
  }
  if (resolved.issuerClone === input.ourCloneAddress.toLowerCase()) {
    return {tagResolution: "issued_here_unlinked", issuerClone: resolved.issuerClone, dogTagIdField: resolved.dogTagIdField, root: resolved.root};
  }

  // Tier 4: external. Validity is checked against the ISSUER clone (never our own - `isValid` on
  // our own clone cannot distinguish "foreign" from "revoked", per section 3's own note) via the
  // shared verifier's stage 2.
  const dataResult = await verifyTagDataAgainstRoot(deps, {
    issuerClone: resolved.issuerClone,
    root: resolved.root,
    leaves: input.leaves,
    reservedLeafHashes: input.reservedLeafHashes,
  });
  if (!dataResult.ok) {
    return {tagResolution: "unknown", verificationError: true};
  }

  let existingExternalPetId: string | undefined;
  if (dataResult.dataVerified) {
    const existing = await store.findExternalPetByDogTagField(resolved.dogTagIdField);
    existingExternalPetId = existing?.petId;
  }

  return {
    tagResolution: "external",
    issuerClone: resolved.issuerClone,
    dogTagIdField: resolved.dogTagIdField,
    root: resolved.root,
    issuerValid: dataResult.issuerValid,
    dataVerificationAttempted: dataResult.dataVerificationAttempted,
    dataVerified: dataResult.dataVerified,
    ...(dataResult.verifiedAttributes ? {verifiedAttributes: dataResult.verifiedAttributes} : {}),
    ...(existingExternalPetId ? {existingExternalPetId} : {}),
  };
}

/**
 * Maps a `TagClaimResult` plus the wallet-claim outcome onto the persisted `Appointment.
 * bookingIdentity` shape - the ONE place this translation happens, so the booking route itself
 * never hand-assembles this subdoc field-by-field. Pure and total: every `TagClaimResult` variant
 * maps to exactly one `BookingIdentity`, carrying only the fields that variant's own doc comment
 * says apply (an `"external"` result never carries `candidatePetId`, etc.).
 */
export function toBookingIdentity(params: {
  walletAddress?: string;
  walletVerified: boolean;
  bookingHash?: string;
  dogTagIdDec?: string;
  /** Review finding 6 - see `BookingIdentity.walletMultiMatch`. Persisted only when true (the
   * field exists to mark the one case it is true for, the house style for flags), so `false` and
   * absent land identically. */
  walletMultiMatch?: boolean;
  tagClaim: TagClaimResult;
}): BookingIdentity {
  const base: BookingIdentity = {
    walletAddress: params.walletAddress,
    walletVerified: params.walletVerified,
    bookingHash: params.bookingHash,
    dogTagIdDec: params.dogTagIdDec,
    ...(params.walletMultiMatch ? {walletMultiMatch: true} : {}),
    tagResolution: params.tagClaim.tagResolution,
  };
  const tagClaim = params.tagClaim;
  switch (tagClaim.tagResolution) {
    case "local":
      return tagClaim.needsReview ? {...base, needsReview: true, candidatePetId: tagClaim.candidatePetId} : base;
    case "unknown":
      return {...base, verificationError: tagClaim.verificationError};
    case "issued_here_unlinked":
      return {...base, issuerClone: tagClaim.issuerClone};
    case "external":
      return {
        ...base,
        issuerClone: tagClaim.issuerClone,
        issuerValid: tagClaim.issuerValid,
        dataVerificationAttempted: tagClaim.dataVerificationAttempted,
        dataVerified: tagClaim.dataVerified,
      };
    case "none":
      return base;
  }
}
