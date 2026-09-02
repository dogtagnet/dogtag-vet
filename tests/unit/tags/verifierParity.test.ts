import {describe, expect, it, vi} from "vitest";
import {
  buildMerkle,
  dogTagIdField,
  hashLeaf,
  hexToBytes,
  toHex32,
  TypeTag,
  verifyLeafCommitment,
  type OpenedLeaf,
  type TypedScalar,
} from "@dogtag/standard";
import {resolveTagClaim, type MobileTagLookupStore} from "@/lib/booking/mobileReconcile";
import {completeImport, type ImportFlowStore, type ImportSessionRow} from "@/lib/tags/importFlow";
import type {TagDataChainDeps} from "@/lib/tags/verifier";

/**
 * D7 (WP4.9V GRADE ROUND 1, plan section 2.5's own text: "shared-verifier parity with the WP4.4
 * path (same fixtures both ways)"). What existed before this file: `mobileReconcile.test.ts`'s 29
 * pre-existing tests prove the extraction is BEHAVIOR-PRESERVING for the booking caller alone, and
 * `verifier.test.ts`'s 16 tests exercise the shared module directly - but nothing drove ONE fixture
 * through BOTH `resolveTagClaim` (booking) and `completeImport` (import) and asserted their
 * verdicts agree. This file is that missing test: one table of fixtures, both callers, pinned
 * verdict pairs - including the ONE deliberate divergence `verifier.ts`'s own doc comment names
 * (the "issued_here_unlinked" short-circuit: booking never reaches the isValid/data-verification
 * stage for our own clone's unlinked tags, import always does).
 *
 * Each row builds its OWN pair of `TagDataChainDeps` fakes (one per caller) rather than sharing a
 * single mutable object, so `readIsValidRoot`'s call count can be asserted independently per side -
 * both fakes are still configured identically (same resolved values), so this is "the same
 * fixtures both ways" in every sense that matters: same leaves, same root, same reserved hashes,
 * same chain-read answers.
 */

const OUR_CLONE = "0x5bd5048125f223100a2753a740f34d044ab493b";
const FOREIGN_CLONE = "0x57f8786264c55cdd8f3ece0ba177f6ad2df90e0";
const ZERO_HEX32 = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DOG_TAG_ID_DEC = "42";
const DOG_TAG_ID_FIELD = dogTagIdField(DOG_TAG_ID_DEC).toString(10);
const NOW = 1_735_689_600;

/** A genuine (leaves, reservedLeafHashes, root) triple `verifyLeafCommitment` accepts - same
 * primitives every sibling test file in this directory already builds fixtures with. */
function buildVerifiableFixture(nameValue = "Rex"): {leaves: OpenedLeaf[]; reservedLeafHashes: string[]; root: string} {
  const salt = (n: number) => new Uint8Array(16).fill(n);
  const saltHexOf = (n: number) => ("0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
  const leaves: OpenedLeaf[] = [
    {keyPath: "credentialSubject.species", saltHex: saltHexOf(11), tag: TypeTag.String, value: "dog"},
    {keyPath: "credentialSubject.name", saltHex: saltHexOf(12), tag: TypeTag.String, value: nameValue},
  ];
  const reservedLeafHashes = [
    toHex32(hashLeaf("owner.address", salt(201), {tag: TypeTag.Bytes, value: new Uint8Array([1])} as TypedScalar)),
    toHex32(hashLeaf("owner.consentKey", salt(202), {tag: TypeTag.Bytes, value: new Uint8Array([2])} as TypedScalar)),
    toHex32(hashLeaf("owner.secret", salt(203), {tag: TypeTag.Bytes, value: new Uint8Array([3])} as TypedScalar)),
  ];
  const reservedFields = reservedLeafHashes.map((h) => BigInt(h));
  const leafFields = leaves.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), {tag: l.tag, value: l.value} as TypedScalar));
  const root = toHex32(buildMerkle([...reservedFields, ...leafFields]).root);
  expect(verifyLeafCommitment({root, leaves, reservedLeafHashes, expectedIdentityLeaves: []})).toBe(true);
  return {leaves, reservedLeafHashes, root};
}

function chainDeps(config: {
  root?: string;
  issuer?: string;
  isValid?: boolean;
  profileRootThrows?: boolean;
}): TagDataChainDeps & {isValidRootCalls: string[]} {
  const isValidRootCalls: string[] = [];
  return {
    isValidRootCalls,
    readProfileRoot: config.profileRootThrows
      ? vi.fn().mockRejectedValue(new Error("rpc unreachable"))
      : vi.fn().mockResolvedValue(config.root ?? ZERO_HEX32),
    readRootIssuer: vi.fn().mockResolvedValue(config.issuer ?? ZERO_ADDRESS),
    readIsValidRoot: vi.fn(async (issuerClone: string) => {
      isValidRootCalls.push(issuerClone);
      return config.isValid ?? true;
    }),
  };
}

/** Tier 1 always misses (no local pet on file for this claim) - the shape every row below needs to
 * actually reach the shared verifier at all. */
function bookingStore(): MobileTagLookupStore {
  return {findLocalPetByDogTag: vi.fn().mockResolvedValue(null), findExternalPetByDogTagField: vi.fn().mockResolvedValue(null)};
}

function importSession(overrides: Partial<ImportSessionRow> = {}): ImportSessionRow {
  return {token: "a".repeat(32), clinicName: "Example Vet Clinic", ourCloneAddress: OUR_CLONE, exp: NOW + 600, ...overrides};
}

/** Minimal `ImportFlowStore` fake for the CREATE-NEW-PET path (no `targetPetId`) - the parity
 * question this file asks is "do the two callers reach the same VERIFICATION verdict", which
 * create-new exercises without also needing a target-pet attach fixture. */
function importStore(session: ImportSessionRow): ImportFlowStore & {createdArtifacts: {petId: string; root: string}[]} {
  const sessions = new Map<string, ImportSessionRow>([[session.token, {...session}]]);
  const createdArtifacts: {petId: string; root: string}[] = [];
  let nextPetId = 1;
  return {
    createdArtifacts,
    async getByToken(token) {
      const row = sessions.get(token);
      return row ? {...row} : null;
    },
    async tryConsume(token, now) {
      const row = sessions.get(token);
      if (!row || row.usedAt !== undefined) return false;
      row.usedAt = now;
      return true;
    },
    async previewTargetPet() {
      return null;
    },
    async findExistingPetAttributes() {
      return null;
    },
    async attachToExistingPet() {
      return {ok: false};
    },
    async createPetFromImport(attributes) {
      const petId = `new-pet-${nextPetId++}`;
      return {petId, petName: attributes.name?.trim() || "Imported pet"};
    },
    async createImportedArtifact(input) {
      createdArtifacts.push({petId: input.petId, root: input.root});
    },
  };
}

describe("shared-verifier parity: resolveTagClaim (booking) vs completeImport (import), same fixtures both ways", () => {
  it("clean external valid tag: booking reports external/dataVerified, import succeeds - both actually called isValid", async () => {
    const fixture = buildVerifiableFixture("Rex");
    const bookingDeps = chainDeps({root: fixture.root, issuer: FOREIGN_CLONE, isValid: true});
    const importDeps = chainDeps({root: fixture.root, issuer: FOREIGN_CLONE, isValid: true});

    const claim = await resolveTagClaim(bookingStore(), bookingDeps, {
      dogTagIdDec: DOG_TAG_ID_DEC,
      resolvedClientId: "client-1",
      ourCloneAddress: OUR_CLONE,
      leaves: fixture.leaves,
      reservedLeafHashes: fixture.reservedLeafHashes,
    });
    expect(claim).toEqual({
      tagResolution: "external",
      issuerClone: FOREIGN_CLONE,
      dogTagIdField: DOG_TAG_ID_FIELD,
      root: fixture.root,
      issuerValid: true,
      dataVerificationAttempted: true,
      dataVerified: true,
      verifiedAttributes: {name: "Rex", species: "dog"},
    });
    expect(bookingDeps.isValidRootCalls).toEqual([FOREIGN_CLONE]);

    const session = importSession();
    const result = await completeImport(
      importStore(session),
      importDeps,
      {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, leaves: fixture.leaves, reservedLeafHashes: fixture.reservedLeafHashes},
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.created).toBe(true);
    expect(importDeps.isValidRootCalls).toEqual([FOREIGN_CLONE]);
  });

  it("revoked at issuer: booking reports dataVerified:false (still 'external'), import refuses 'revoked'", async () => {
    const fixture = buildVerifiableFixture("Rex");
    const bookingDeps = chainDeps({root: fixture.root, issuer: FOREIGN_CLONE, isValid: false});
    const importDeps = chainDeps({root: fixture.root, issuer: FOREIGN_CLONE, isValid: false});

    const claim = await resolveTagClaim(bookingStore(), bookingDeps, {
      dogTagIdDec: DOG_TAG_ID_DEC,
      resolvedClientId: "client-1",
      ourCloneAddress: OUR_CLONE,
      leaves: fixture.leaves,
      reservedLeafHashes: fixture.reservedLeafHashes,
    });
    expect(claim).toEqual({
      tagResolution: "external",
      issuerClone: FOREIGN_CLONE,
      dogTagIdField: DOG_TAG_ID_FIELD,
      root: fixture.root,
      issuerValid: false,
      dataVerificationAttempted: true,
      dataVerified: false,
    });

    const session = importSession();
    const result = await completeImport(
      importStore(session),
      importDeps,
      {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, leaves: fixture.leaves, reservedLeafHashes: fixture.reservedLeafHashes},
      NOW,
    );
    expect(result).toEqual({ok: false, code: "revoked"});
  });

  it("leaf mismatch (tampered leaves, valid issuer): booking reports dataVerified:false, import refuses 'verify_failed'", async () => {
    const fixture = buildVerifiableFixture("Rex");
    const tamperedLeaves = fixture.leaves.map((l) => (l.keyPath === "credentialSubject.name" ? {...l, value: "Max"} : l));
    const bookingDeps = chainDeps({root: fixture.root, issuer: FOREIGN_CLONE, isValid: true});
    const importDeps = chainDeps({root: fixture.root, issuer: FOREIGN_CLONE, isValid: true});

    const claim = await resolveTagClaim(bookingStore(), bookingDeps, {
      dogTagIdDec: DOG_TAG_ID_DEC,
      resolvedClientId: "client-1",
      ourCloneAddress: OUR_CLONE,
      leaves: tamperedLeaves,
      reservedLeafHashes: fixture.reservedLeafHashes,
    });
    expect(claim).toEqual({
      tagResolution: "external",
      issuerClone: FOREIGN_CLONE,
      dogTagIdField: DOG_TAG_ID_FIELD,
      root: fixture.root,
      issuerValid: true,
      dataVerificationAttempted: true,
      dataVerified: false,
    });

    const session = importSession();
    const result = await completeImport(
      importStore(session),
      importDeps,
      {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, leaves: tamperedLeaves, reservedLeafHashes: fixture.reservedLeafHashes},
      NOW,
    );
    expect(result).toEqual({ok: false, code: "verify_failed"});
  });

  it("chain unreadable (readProfileRoot throws): booking folds to 'unknown'/verificationError, import refuses 'chain_unreadable'", async () => {
    const bookingDeps = chainDeps({profileRootThrows: true});
    const importDeps = chainDeps({profileRootThrows: true});

    const claim = await resolveTagClaim(bookingStore(), bookingDeps, {
      dogTagIdDec: DOG_TAG_ID_DEC,
      resolvedClientId: "client-1",
      ourCloneAddress: OUR_CLONE,
    });
    expect(claim).toEqual({tagResolution: "unknown", verificationError: true});
    expect(bookingDeps.isValidRootCalls).toEqual([]); // never reached stage 2

    const session = importSession();
    const result = await completeImport(importStore(session), importDeps, {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, leaves: [], reservedLeafHashes: []}, NOW);
    expect(result).toEqual({ok: false, code: "chain_unreadable"});
    expect(importDeps.isValidRootCalls).toEqual([]);
  });

  it("dec/field mismatch (malformed_claim): both refuse identically, before any chain read at all", async () => {
    const bookingDeps = chainDeps({root: `0x${"11".repeat(32)}`, issuer: FOREIGN_CLONE, isValid: true});
    const importDeps = chainDeps({root: `0x${"11".repeat(32)}`, issuer: FOREIGN_CLONE, isValid: true});

    const claim = await resolveTagClaim(bookingStore(), bookingDeps, {
      dogTagIdDec: DOG_TAG_ID_DEC,
      dogTagIdField: "999999999", // does not match the field derived from DOG_TAG_ID_DEC
      resolvedClientId: "client-1",
      ourCloneAddress: OUR_CLONE,
    });
    expect(claim).toEqual({tagResolution: "unknown", verificationError: true});
    expect(bookingDeps.readProfileRoot).not.toHaveBeenCalled();

    const session = importSession();
    const result = await completeImport(
      importStore(session),
      importDeps,
      {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, dogTagIdField: "999999999", leaves: [], reservedLeafHashes: []},
      NOW,
    );
    expect(result).toEqual({ok: false, code: "malformed_claim"});
    expect(importDeps.readProfileRoot).not.toHaveBeenCalled();
  });

  it("root_unset: booking reports 'unknown' with NO verificationError, import refuses 'root_unset'", async () => {
    const bookingDeps = chainDeps({root: ZERO_HEX32});
    const importDeps = chainDeps({root: ZERO_HEX32});

    const claim = await resolveTagClaim(bookingStore(), bookingDeps, {
      dogTagIdDec: DOG_TAG_ID_DEC,
      resolvedClientId: "client-1",
      ourCloneAddress: OUR_CLONE,
    });
    expect(claim).toEqual({tagResolution: "unknown", verificationError: false});

    const session = importSession();
    const result = await completeImport(importStore(session), importDeps, {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, leaves: [], reservedLeafHashes: []}, NOW);
    expect(result).toEqual({ok: false, code: "root_unset"});
  });

  it("our-own-clone: the ONE deliberate divergence - booking short-circuits BEFORE isValid, import always runs both stages", async () => {
    // This is exactly the boundary `lib/tags/verifier.ts`'s own doc comment names: booking's tier 3
    // ("issued_here_unlinked") never needs isValid/data-verification for a tag issued by THIS
    // clinic's own clone (that is a staff-initiated relink, not a claim resolution or an import),
    // while the WP4.9 import ceremony DOES need both stages regardless of which clone issued the
    // tag (Kenneth's Q3 precedent: reclaiming your own tag must verify exactly like a foreign one).
    const fixture = buildVerifiableFixture("Rex");
    const bookingDeps = chainDeps({root: fixture.root, issuer: OUR_CLONE, isValid: true});
    const importDeps = chainDeps({root: fixture.root, issuer: OUR_CLONE, isValid: true});

    const claim = await resolveTagClaim(bookingStore(), bookingDeps, {
      dogTagIdDec: DOG_TAG_ID_DEC,
      resolvedClientId: "client-1",
      ourCloneAddress: OUR_CLONE,
      leaves: fixture.leaves,
      reservedLeafHashes: fixture.reservedLeafHashes,
    });
    expect(claim).toEqual({
      tagResolution: "issued_here_unlinked",
      issuerClone: OUR_CLONE,
      dogTagIdField: DOG_TAG_ID_FIELD,
      root: fixture.root,
    });
    expect(bookingDeps.isValidRootCalls).toEqual([]); // the divergence: booking NEVER calls isValid here

    const session = importSession({ourCloneAddress: OUR_CLONE});
    const result = await completeImport(
      importStore(session),
      importDeps,
      {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, leaves: fixture.leaves, reservedLeafHashes: fixture.reservedLeafHashes},
      NOW,
    );
    expect(result.ok).toBe(true); // the reclaim case still succeeds - import proceeds through both stages
    expect(importDeps.isValidRootCalls).toEqual([OUR_CLONE]); // the divergence: import DOES call isValid here
  });
});
