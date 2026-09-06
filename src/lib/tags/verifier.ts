import {dogTagIdField as computeDogTagIdField, TypeTag, verifyRedactedArtifact, type OpenedLeaf} from "@dogtag/standard";
import type {PetSex} from "@/lib/models/Pet";

/**
 * The shared chain-plus-data verifier (plans/wp4.9-tag-data-custody.md section 2.3) - the WP4.4
 * tier-gate chain checks (dec<->field recompute, profileRoot, rootIssuer, isValid vs ISSUER clone,
 * verifyLeafCommitment), extracted from `lib/booking/mobileReconcile.ts`'s tier 2-4 so both booking's
 * `resolveTagClaim` and the WP4.9 import ceremony call the exact same code, never a fork.
 *
 * BEHAVIOR-PRESERVING split into TWO functions, not one, for a reason proven empirically against
 * this repo's own existing test (`tests/unit/booking/mobileReconcile.test.ts`, the
 * '"issued_here_unlinked" (case-insensitively)' case): that test asserts
 * `expect(deps.readIsValidRoot).not.toHaveBeenCalled()` for a root whose issuer is THIS clinic's
 * own clone - booking's tier 3 short-circuits to `issued_here_unlinked` before ever reading
 * validity. A single do-everything function would have to call `readIsValidRoot` unconditionally
 * (or accept `ourCloneAddress` and re-implement that branch internally, which only moves the same
 * decision one level down) - either way it changes an already-tested chain-call count for the
 * booking path. Splitting at exactly the "the issuer is now known" boundary lets each caller decide
 * whether to even reach the isValid/data-verification stage, matching the two callers' genuinely
 * different needs: booking never validates/data-verifies its own clone's unlinked tags (that is a
 * staff-initiated relink, `/api/appointments/:id/relink-dogtag`), while the WP4.9 import ceremony
 * (`lib/tags/importFlow.ts`) DOES need both stages regardless of which clone issued the tag (Kenneth's
 * Q3 precedent - "import only what verifies on chain AND data-verifies" - applies to a reclaimed own
 * tag exactly the same as a foreign one).
 */
export interface TagDataChainDeps {
  /** `DogTagSBTConsent.profileRoot(dogTagIdField)` - the zero hash when never issued. */
  readProfileRoot(dogTagIdFieldDec: string): Promise<string>;
  /** `VetIssuerFactory.rootIssuer(root)` - the zero address when the factory never indexed it. */
  readRootIssuer(root: string): Promise<string>;
  /** `VetIssuer.isValid(root)` against the ISSUER clone passed in (never assumed to be "our own" -
   * the caller decides which clone to check validity against). */
  readIsValidRoot(issuerCloneAddress: string, root: string): Promise<boolean>;
}

export interface VerifiedPetAttributes {
  name?: string;
  species?: string;
  breed?: string;
  sex?: PetSex;
  dateOfBirth?: string;
  // WP4.12 (Kenneth issue 2)
  color?: string;
  registrationId?: string;
  registrationAuthority?: string;
}

/** `credentialSubject.*` is the disclosed-attribute namespace, distinct from `owner.*`/
 * `owner.identity.*` (owner data, never imported onto a Pet record). Only `TypeTag.String` leaves
 * are read for these fields - every field this maps onto is itself a plain string on `PetDoc`. */
const NAME_KEY_PATH = "credentialSubject.name";
const SPECIES_KEY_PATH = "credentialSubject.species";
const BREED_LABEL_KEY_PATH = "credentialSubject.breedLabel";
const BREED_VBO_KEY_PATH = "credentialSubject.breedVbo";
const SEX_KEY_PATH = "credentialSubject.sex";
const DATE_OF_BIRTH_KEY_PATH = "credentialSubject.dateOfBirth";
// WP4.12 (Kenneth issue 2) - the three optional profile leaves, import-side.
const COLOR_KEY_PATH = "credentialSubject.color";
const REGISTRATION_ID_KEY_PATH = "credentialSubject.registrationId";
const REGISTRATION_AUTHORITY_KEY_PATH = "credentialSubject.registrationAuthority";
const VALID_PET_SEXES: readonly PetSex[] = ["male", "female", "unknown"];

/**
 * Best-effort mapping from a VERIFIED leaf set (leaves that already passed `verifyLeafCommitment`
 * against the on-chain root - never called on unverified input) onto the subset of `PetDoc`
 * fields WP4.4/WP4.9 import: "name, species, breed, ...". Never throws: an unrecognized
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
    color: get(COLOR_KEY_PATH),
    registrationId: get(REGISTRATION_ID_KEY_PATH),
    registrationAuthority: get(REGISTRATION_AUTHORITY_KEY_PATH),
  };
  // Strip undefined keys so equality assertions against a plain `{}` (no claims at all) hold -
  // `VerifiedPetAttributes`'s fields are all optional, but an object literal with every value
  // `undefined` is not structurally `{}` under `toEqual`.
  return Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== undefined)) as VerifiedPetAttributes;
}

const ZERO_HEX32 = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * The `owner.identity.*` subset of a disclosed leaf set - used both by `verifyTagDataAgainstRoot`
 * below (checked against ITSELF, the deliberate no-op documented on `TagDataVerification.dataVerified`)
 * and by every "imported" `TagArtifact` write path (`lib/booking/postBooking.ts`'s WP4.4 side
 * effect, the WP4.9 import ceremony) that needs the identical `expectedIdentityLeaves` a second,
 * independent `verifyLeafCommitment` call requires - there is no vet-attested record to check an
 * imported claim against, unlike custodial-bind's real cross-check.
 */
export function identityLeafSelfCheckSubset(leaves: OpenedLeaf[]): OpenedLeaf[] {
  return leaves.filter((leaf) => leaf.keyPath.startsWith("owner.identity."));
}

export interface ResolveTagRootAndIssuerInput {
  dogTagIdDec?: string;
  /** When absent, derived from `dogTagIdDec` via `@dogtag/standard`'s `dogTagIdField` (no chain
   * read - pure computation). When both are present, the derivation from `dogTagIdDec` must equal
   * this exactly - never a half-trusted mix of a real signed field with an arbitrary decimal label. */
  dogTagIdField?: string;
}

export type RootIssuerResolution =
  | {
      ok: false;
      /** `malformed_claim`: the dec/field pair is internally inconsistent, or `dogTagIdDec` is not
       * a canonical integer - a claim problem, not a chain problem.
       * `chain_unreadable`: a `readProfileRoot`/`readRootIssuer` call threw.
       * `root_unset`: the chain was read successfully and the root is genuinely the zero hash -
       * this tag was never issued (or never anchored) at all.
       * `issuer_unknown`: defensive only - a nonzero root with a zero `rootIssuer` should never
       * occur on a consistent chain (`indexRoot` and the root write happen atomically together). */
      reason: "malformed_claim" | "chain_unreadable" | "root_unset" | "issuer_unknown";
    }
  | {ok: true; dogTagIdField: string; root: string; issuerClone: string};

/**
 * Stage 1 of the shared verifier: dec<->field consistency, `profileRoot`, `rootIssuer`. Stops here
 * deliberately - see this module's own doc comment for why the isValid/data-verification stage is
 * a SEPARATE function callers opt into once they know what to do with the issuer.
 */
export async function resolveTagRootAndIssuer(
  deps: Pick<TagDataChainDeps, "readProfileRoot" | "readRootIssuer">,
  input: ResolveTagRootAndIssuerInput,
): Promise<RootIssuerResolution> {
  let dogTagIdFieldDec: string;
  if (input.dogTagIdField) {
    if (input.dogTagIdDec) {
      let derivedFromDec: string;
      try {
        derivedFromDec = computeDogTagIdField(input.dogTagIdDec).toString(10);
      } catch {
        return {ok: false, reason: "malformed_claim"};
      }
      if (derivedFromDec !== input.dogTagIdField) {
        return {ok: false, reason: "malformed_claim"};
      }
    }
    dogTagIdFieldDec = input.dogTagIdField;
  } else {
    try {
      dogTagIdFieldDec = computeDogTagIdField(input.dogTagIdDec!).toString(10);
    } catch {
      return {ok: false, reason: "malformed_claim"};
    }
  }

  let root: string;
  try {
    root = await deps.readProfileRoot(dogTagIdFieldDec);
  } catch {
    return {ok: false, reason: "chain_unreadable"};
  }
  if (root.toLowerCase() === ZERO_HEX32) {
    return {ok: false, reason: "root_unset"};
  }

  let issuer: string;
  try {
    issuer = await deps.readRootIssuer(root);
  } catch {
    return {ok: false, reason: "chain_unreadable"};
  }
  if (issuer.toLowerCase() === ZERO_ADDRESS) {
    return {ok: false, reason: "issuer_unknown"};
  }

  return {ok: true, dogTagIdField: dogTagIdFieldDec, root, issuerClone: issuer.toLowerCase()};
}

export interface VerifyTagDataAgainstRootInput {
  issuerClone: string;
  root: string;
  /** `resolveTagRootAndIssuer`'s own output field of the same name - not itself read by
   * `verifyRedactedArtifact` (an on-chain-binding field, never a leaf), but part of the wire shape
   * its TYPE expects, and a real value both callers of this function already have on hand. */
  dogTagIdField: string;
  /** The pet's DISCLOSED profile-tree leaves plus the 3 reserved owner-control leaf hashes. Both
   * fields absent (or empty), with `obfuscatedLeafHashes` also empty, means "no data sent" - a
   * legitimate, common shape, not an error. */
  leaves?: OpenedLeaf[];
  reservedLeafHashes?: string[];
  /** WP4.10V - leaves named only by their opaque hash (a REDACTED artifact - the WP4.9 import
   * ceremony receiving a masked share). Absent/empty for every pre-WP4.10V caller (the WP4.4
   * booking claim never carries this at all), so this generalization changes nothing for booking's
   * own tier-4 use. `leaves` MAY legitimately be empty while this is non-empty - a fully-masked
   * artifact (`disclosed: []`) still verifies, per specs/leaf-commitment.md section 15. */
  obfuscatedLeafHashes?: string[];
}

export type TagDataVerification =
  | {ok: false}
  | {
      ok: true;
      /** `VetIssuer.isValid(root)` against `issuerClone` - `false` means a revoked (or otherwise
       * invalid) but genuinely-issued tag; still `ok: true` here (the CHAIN read succeeded), just
       * never eligible for import/tier-4 use. */
      issuerValid: boolean;
      /** Did the caller supply BOTH `leaves` and `reservedLeafHashes` (non-empty)? Distinguishes
       * "no data sent" from "data sent but rejected". */
      dataVerificationAttempted: boolean;
      /** `issuerValid && dataVerificationAttempted &&` the sent leaves recompute (via
       * `verifyLeafCommitment`) to `root`. Only when this is `true` were attributes ever derived. */
      dataVerified: boolean;
      /** Present only when `dataVerified` - an attribute pulled from an UNverified leaf set is
       * never a verified attribute. */
      verifiedAttributes?: VerifiedPetAttributes;
    };

/** This app speaks exactly one leaf-commitment protocol version - crypto is frozen
 * (specs/leaf-commitment.md section 12) - so this is the one value `verifyRedactedArtifact`'s
 * (unread, wire-shape-only) `protocolVersion` field ever needs here, matching every other hardcoded
 * `"dogtag-v2/1"` call site in this app (`mongoImportStore.createImportedArtifact`,
 * `issuedArtifactSideEffect.ts`'s own constant). */
const PROTOCOL_VERSION = "dogtag-v2/1";

/**
 * Stage 2 of the shared verifier: `isValid(root)` against `issuerClone`, then (only if data was
 * sent and the issuer is valid) `verifyRedactedArtifact` - WP4.10V's strict generalization of the
 * prior `verifyLeafCommitment` call (see `redactedArtifact.ts`'s own file header in
 * `@dogtag/standard`): a claim with no `obfuscatedLeafHashes` at all (every caller before this
 * wave, and booking's tier-4 claim forever, since its wire format has no such concept) verifies
 * IDENTICALLY either way. There is no vet-attested identity-leaf set to check a claim against here
 * (unlike custodial-bind) - the `owner.identity.*` subset of the disclosed leaves is checked
 * against ITSELF, a deliberate no-op that still exercises every OTHER check the verifier performs
 * (reserved count, leaf cap, no reserved-keyPath spoofing, no duplicate keyPaths, no disclosed/
 * opaque overlap, and - the one that actually matters here - the full Merkle root recompute).
 */
export async function verifyTagDataAgainstRoot(
  deps: Pick<TagDataChainDeps, "readIsValidRoot">,
  input: VerifyTagDataAgainstRootInput,
): Promise<TagDataVerification> {
  let issuerValid: boolean;
  try {
    issuerValid = await deps.readIsValidRoot(input.issuerClone, input.root);
  } catch {
    return {ok: false};
  }

  // "no data sent" (a legitimate, common shape, not an error) means neither an opened leaf NOR an
  // obfuscated hash was ever supplied - a fully-masked artifact (`leaves` empty, `obfuscatedLeafHashes`
  // non-empty) IS an attempt, per specs/leaf-commitment.md section 15's own "disclosed: [] still
  // verifies" case.
  const dataVerificationAttempted =
    Boolean(input.reservedLeafHashes?.length) && (Boolean(input.leaves?.length) || Boolean(input.obfuscatedLeafHashes?.length));
  let dataVerified = false;
  let verifiedAttributes: VerifiedPetAttributes | undefined;
  if (dataVerificationAttempted && issuerValid) {
    const leaves = input.leaves ?? [];
    const identitySubset = identityLeafSelfCheckSubset(leaves);
    dataVerified = verifyRedactedArtifact(
      {
        protocolVersion: PROTOCOL_VERSION,
        dogTagIdField: input.dogTagIdField,
        root: input.root,
        disclosed: leaves,
        obfuscatedLeafHashes: input.obfuscatedLeafHashes ?? [],
        reservedLeafHashes: input.reservedLeafHashes!,
        issuerClone: input.issuerClone,
      },
      {expectedIdentityLeaves: identitySubset},
    );
    // An attribute is only ever derived from a leaf THIS caller actually saw the opening for -
    // masked leaves contribute no attribute, honestly (mapVerifiedLeavesToPetAttributes never sees
    // them at all, since they are not in `leaves`).
    if (dataVerified) verifiedAttributes = mapVerifiedLeavesToPetAttributes(leaves);
  }

  return {
    ok: true,
    issuerValid,
    dataVerificationAttempted,
    dataVerified,
    ...(verifiedAttributes ? {verifiedAttributes} : {}),
  };
}
