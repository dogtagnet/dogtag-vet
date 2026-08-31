import {dogTagIdField as computeDogTagIdField, TypeTag, verifyLeafCommitment, type OpenedLeaf} from "@dogtag/standard";
import type {PetSex} from "@/lib/models/Pet";
import type {BookingIdentity} from "@/lib/models/Appointment";

const ZERO_HEX32 = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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

/** Fail-closed chain reads `resolveTagClaim` needs (`lib/chainRead.ts`'s existing readers,
 * `readRootIssuer` is the new one this WP adds) - injected for the same testability reason as
 * `MobileTagLookupStore` above. Every method here is allowed to THROW (an unreachable RPC, per
 * every other reader in this app) - `resolveTagClaim` catches every one of these and folds a
 * failure into `{tagResolution: "unknown", verificationError: true}` rather than propagating, so a
 * chain hiccup degrades the TAG CLAIM only and never loses the booking itself. */
export interface MobileTagChainDeps {
  /** `DogTagSBTConsent.profileRoot(dogTagIdField)` - the zero hash when never issued. */
  readProfileRoot(dogTagIdFieldDec: string): Promise<string>;
  /** `VetIssuerFactory.rootIssuer(root)` - the zero address when the factory never indexed it. */
  readRootIssuer(root: string): Promise<string>;
  /** `VetIssuer.isValid(root)` against the ISSUER clone (never our own - see section 3's note on
   * why `isValid` on our own clone cannot distinguish foreign from revoked). */
  readIsValidRoot(issuerCloneAddress: string, root: string): Promise<boolean>;
}

export interface VerifiedPetAttributes {
  name?: string;
  species?: string;
  breed?: string;
  sex?: PetSex;
  dateOfBirth?: string;
}

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

/** `credentialSubject.*` is the disclosed-attribute namespace (`OpenedLeaf`'s own wire doc
 * comment: "e.g. `credentialSubject.name`"), distinct from `owner.*`/`owner.identity.*` (owner
 * data, never imported onto a Pet record). Only `TypeTag.String` leaves are read for these fields
 * - every field this maps onto is itself a plain string on `PetDoc`. */
const NAME_KEY_PATH = "credentialSubject.name";
const SPECIES_KEY_PATH = "credentialSubject.species";
const BREED_LABEL_KEY_PATH = "credentialSubject.breedLabel";
const BREED_VBO_KEY_PATH = "credentialSubject.breedVbo";
const SEX_KEY_PATH = "credentialSubject.sex";
const DATE_OF_BIRTH_KEY_PATH = "credentialSubject.dateOfBirth";
const VALID_PET_SEXES: readonly PetSex[] = ["male", "female", "unknown"];

/**
 * Best-effort mapping from a VERIFIED leaf set (leaves that already passed `verifyLeafCommitment`
 * against the on-chain root - never called on unverified input) onto the subset of `PetDoc`
 * fields WP4.4 imports: "name, species, breed, ..." (section 3.4). Never throws: an unrecognized
 * keyPath, a non-string tag, or an invalid enum value for `sex` is silently skipped rather than
 * propagated - this is enrichment of an already-trusted commitment, not a second security check.
 */
export function mapVerifiedLeavesToPetAttributes(leaves: OpenedLeaf[]): VerifiedPetAttributes {
  const byKeyPath = new Map<string, OpenedLeaf>();
  for (const leaf of leaves) {
    if (leaf.tag === TypeTag.String) byKeyPath.set(leaf.keyPath, leaf);
  }
  const get = (keyPath: string): string | undefined => byKeyPath.get(keyPath)?.value;

  const sexValue = get(SEX_KEY_PATH);
  const sex = sexValue !== undefined && (VALID_PET_SEXES as string[]).includes(sexValue) ? (sexValue as PetSex) : undefined;

  const attributes: VerifiedPetAttributes = {
    name: get(NAME_KEY_PATH),
    species: get(SPECIES_KEY_PATH),
    breed: get(BREED_LABEL_KEY_PATH) ?? get(BREED_VBO_KEY_PATH),
    sex,
    dateOfBirth: get(DATE_OF_BIRTH_KEY_PATH),
  };
  // Strip undefined keys so equality assertions against a plain `{}` (no claims at all) hold -
  // `VerifiedPetAttributes`'s fields are all optional, but an object literal with every value
  // `undefined` is not structurally `{}` under `toEqual`.
  return Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== undefined)) as VerifiedPetAttributes;
}

/**
 * Tag claim resolution - plans/wp4.4-mobile-booking-protocol.md section 3, tiers 1-4 (normative,
 * LOCKED). Zero writes: this function only READS (the injected store and chain deps) and performs
 * pure local computation (`verifyLeafCommitment`); the caller creates/links a provisional pet only
 * AFTER the appointment itself is durably inserted (avoids an orphaned provisional Pet if the
 * booking itself then loses a slot-capacity race - see the booking route's own doc comment).
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

  // Tier 2: NOT local -> derive/verify dogTagIdField (no chain) -> readProfileRoot.
  let dogTagIdFieldDec: string;
  if (input.dogTagIdField) {
    // Review finding 5: `bookingHash` binds the signature to `dogTagIdField` alone (see
    // `bookingHash.ts`'s doc comment) - it says nothing about `dogTagIdDec`. When the wire sends
    // BOTH, trusting `dogTagIdField` at face value would let a fabricated `dogTagIdDec` ride along
    // completely unverified into `Pet.create`'s `dogTag.dogTagIdDec` and the provenance box (a real,
    // signed field id paired with an arbitrary decimal label). Require it recompute to the exact
    // same field the wire's own dec claims, or reject the claim outright - never a half-trusted mix.
    if (input.dogTagIdDec) {
      let derivedFromDec: string;
      try {
        derivedFromDec = computeDogTagIdField(input.dogTagIdDec).toString(10);
      } catch {
        return {tagResolution: "unknown", verificationError: true};
      }
      if (derivedFromDec !== input.dogTagIdField) {
        return {tagResolution: "unknown", verificationError: true};
      }
    }
    dogTagIdFieldDec = input.dogTagIdField;
  } else {
    try {
      dogTagIdFieldDec = computeDogTagIdField(input.dogTagIdDec!).toString(10);
    } catch {
      // A malformed dogTagIdDec (not a canonical integer) can't be resolved on chain at all.
      return {tagResolution: "unknown", verificationError: true};
    }
  }

  let root: string;
  try {
    root = await deps.readProfileRoot(dogTagIdFieldDec);
  } catch {
    return {tagResolution: "unknown", verificationError: true};
  }
  if (root.toLowerCase() === ZERO_HEX32) {
    return {tagResolution: "unknown", verificationError: false};
  }

  // Tier 3/4: root exists -> readRootIssuer.
  let issuer: string;
  try {
    issuer = await deps.readRootIssuer(root);
  } catch {
    return {tagResolution: "unknown", verificationError: true};
  }
  if (issuer.toLowerCase() === ZERO_ADDRESS) {
    // Invariant violation, defensive only: `VetIssuer.issueTag`/`issueRecord` always call
    // `factory.indexRoot(root)` atomically in the SAME transaction that sets the root, so a
    // nonzero root with a zero `rootIssuer` should never occur on a consistent chain. Fail closed
    // rather than guess.
    return {tagResolution: "unknown", verificationError: true};
  }
  if (issuer.toLowerCase() === input.ourCloneAddress.toLowerCase()) {
    return {tagResolution: "issued_here_unlinked", issuerClone: issuer.toLowerCase(), dogTagIdField: dogTagIdFieldDec, root};
  }

  // Tier 4: external. Validity is checked against the ISSUER clone (never our own - `isValid` on
  // our own clone cannot distinguish "foreign" from "revoked", per section 3's own note).
  let issuerValid: boolean;
  try {
    issuerValid = await deps.readIsValidRoot(issuer, root);
  } catch {
    return {tagResolution: "unknown", verificationError: true};
  }

  const dataVerificationAttempted = Boolean(input.leaves?.length) && Boolean(input.reservedLeafHashes?.length);
  let dataVerified = false;
  let verifiedAttributes: VerifiedPetAttributes | undefined;
  if (dataVerificationAttempted && issuerValid) {
    // Q3's gate is level-2 (data-verified), not level-3 (ownership-proven): there is no
    // vet-attested identity-leaf set to check this claim against (unlike custodial-bind, this pet
    // was never issued here) - the identity-leaf subset is checked against ITSELF, a deliberate
    // no-op that still exercises every OTHER check `verifyLeafCommitment` performs (reserved
    // count, leaf cap, no reserved-keyPath spoofing, no duplicate keyPaths, and - the one that
    // actually matters here - the full Merkle root recompute against the on-chain `root`).
    const identitySubset = input.leaves!.filter((leaf) => leaf.keyPath.startsWith("owner.identity."));
    dataVerified = verifyLeafCommitment({
      root,
      leaves: input.leaves!,
      reservedLeafHashes: input.reservedLeafHashes!,
      expectedIdentityLeaves: identitySubset,
    });
    if (dataVerified) verifiedAttributes = mapVerifiedLeavesToPetAttributes(input.leaves!);
  }

  let existingExternalPetId: string | undefined;
  if (dataVerified) {
    const existing = await store.findExternalPetByDogTagField(dogTagIdFieldDec);
    existingExternalPetId = existing?.petId;
  }

  return {
    tagResolution: "external",
    issuerClone: issuer.toLowerCase(),
    dogTagIdField: dogTagIdFieldDec,
    root,
    issuerValid,
    dataVerificationAttempted,
    dataVerified,
    ...(verifiedAttributes ? {verifiedAttributes} : {}),
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
  tagClaim: TagClaimResult;
}): BookingIdentity {
  const base: BookingIdentity = {
    walletAddress: params.walletAddress,
    walletVerified: params.walletVerified,
    bookingHash: params.bookingHash,
    dogTagIdDec: params.dogTagIdDec,
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
