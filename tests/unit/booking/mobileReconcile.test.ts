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
import {
  type LocalPetMatch,
  type MobileTagChainDeps,
  type MobileTagLookupStore,
  mapVerifiedLeavesToPetAttributes,
  resolveTagClaim,
  toBookingIdentity,
} from "@/lib/booking/mobileReconcile";

const OUR_CLONE = "0x5bd5048125f223100a2753a740f34d044ab493b";
const FOREIGN_CLONE = "0x57f8786264c55cdd8f3ece0ba177f6ad2df90e0";
const ZERO_HEX32 = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DOG_TAG_ID_DEC = "42";
const DOG_TAG_ID_FIELD = dogTagIdField(DOG_TAG_ID_DEC).toString(10);
const A_ROOT = `0x${"11".repeat(32)}`;

function fakeStore(overrides: Partial<MobileTagLookupStore> = {}): MobileTagLookupStore {
  return {
    findLocalPetByDogTag: vi.fn().mockResolvedValue(null),
    findExternalPetByDogTagField: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<MobileTagChainDeps> = {}): MobileTagChainDeps {
  return {
    readProfileRoot: vi.fn().mockResolvedValue(ZERO_HEX32),
    readRootIssuer: vi.fn().mockResolvedValue(ZERO_ADDRESS),
    readIsValidRoot: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("resolveTagClaim", () => {
  it('returns "none" when no tag claim is present at all', async () => {
    const result = await resolveTagClaim(fakeStore(), fakeDeps(), {resolvedClientId: "client-1", ourCloneAddress: OUR_CLONE});
    expect(result).toEqual({tagResolution: "none"});
    // No chain read should happen for a claim-free booking.
  });

  describe("tier 1: LOCAL match", () => {
    it("links the pet when the resolved client is among its owners", async () => {
      const local: LocalPetMatch = {petId: "pet-1", ownerClientIds: ["client-1", "client-2"]};
      const store = fakeStore({findLocalPetByDogTag: vi.fn().mockResolvedValue(local)});
      const deps = fakeDeps();

      const result = await resolveTagClaim(store, deps, {dogTagIdDec: DOG_TAG_ID_DEC, resolvedClientId: "client-1", ourCloneAddress: OUR_CLONE});

      expect(result).toEqual({tagResolution: "local", petId: "pet-1", needsReview: false});
      expect(deps.readProfileRoot).not.toHaveBeenCalled(); // local match short-circuits the chain entirely
    });

    it("does NOT silently link, and flags for review, when the resolved client is NOT among the pet's owners (hijack guard)", async () => {
      const local: LocalPetMatch = {petId: "pet-1", ownerClientIds: ["someone-elses-client"]};
      const store = fakeStore({findLocalPetByDogTag: vi.fn().mockResolvedValue(local)});

      const result = await resolveTagClaim(store, fakeDeps(), {dogTagIdDec: DOG_TAG_ID_DEC, resolvedClientId: "attacker-client", ourCloneAddress: OUR_CLONE});

      expect(result).toEqual({tagResolution: "local", needsReview: true, candidatePetId: "pet-1"});
    });
  });

  describe("tier 2: not local, zero root", () => {
    it('resolves "unknown" (booking kept, claim rejected) with no verificationError when the root is genuinely unset', async () => {
      const deps = fakeDeps({readProfileRoot: vi.fn().mockResolvedValue(ZERO_HEX32)});
      const result = await resolveTagClaim(fakeStore(), deps, {dogTagIdDec: DOG_TAG_ID_DEC, resolvedClientId: "client-1", ourCloneAddress: OUR_CLONE});
      expect(result).toEqual({tagResolution: "unknown", verificationError: false});
      expect(deps.readRootIssuer).not.toHaveBeenCalled();
    });

    it("derives dogTagIdField from dogTagIdDec when the wire only supplied the decimal handle", async () => {
      const deps = fakeDeps();
      await resolveTagClaim(fakeStore(), deps, {dogTagIdDec: DOG_TAG_ID_DEC, resolvedClientId: "client-1", ourCloneAddress: OUR_CLONE});
      expect(deps.readProfileRoot).toHaveBeenCalledWith(DOG_TAG_ID_FIELD);
    });

    it("uses the wire-supplied dogTagIdField directly when given, without re-deriving it", async () => {
      const deps = fakeDeps();
      await resolveTagClaim(fakeStore(), deps, {dogTagIdField: "999", resolvedClientId: "client-1", ourCloneAddress: OUR_CLONE});
      expect(deps.readProfileRoot).toHaveBeenCalledWith("999");
    });

    it("accepts a wire-supplied dogTagIdField that matches the value recomputed from dogTagIdDec", async () => {
      const deps = fakeDeps();
      await resolveTagClaim(fakeStore(), deps, {
        dogTagIdDec: DOG_TAG_ID_DEC,
        dogTagIdField: DOG_TAG_ID_FIELD,
        resolvedClientId: "client-1",
        ourCloneAddress: OUR_CLONE,
      });
      expect(deps.readProfileRoot).toHaveBeenCalledWith(DOG_TAG_ID_FIELD);
    });

    it("review finding 5: rejects the claim (unknown, verificationError) when a wire-supplied dogTagIdField does NOT match dogTagIdDec, rather than trusting the field blindly - bookingHash only binds dogTagIdField, so an unbound dogTagIdDec could otherwise ride along unverified into Pet.create/the provenance box", async () => {
      const deps = fakeDeps();
      const result = await resolveTagClaim(fakeStore(), deps, {
        dogTagIdDec: DOG_TAG_ID_DEC,
        dogTagIdField: "123456789", // does not match dogTagIdField(DOG_TAG_ID_DEC)
        resolvedClientId: "client-1",
        ourCloneAddress: OUR_CLONE,
      });
      expect(result).toEqual({tagResolution: "unknown", verificationError: true});
      expect(deps.readProfileRoot).not.toHaveBeenCalled();
    });
  });

  describe("chain-read failure - must never lose the booking", () => {
    it("resolves unknown with verificationError:true when profileRoot is unreadable, rather than throwing", async () => {
      const deps = fakeDeps({readProfileRoot: vi.fn().mockRejectedValue(new Error("RPC timeout"))});
      const result = await resolveTagClaim(fakeStore(), deps, {dogTagIdDec: DOG_TAG_ID_DEC, resolvedClientId: "client-1", ourCloneAddress: OUR_CLONE});
      expect(result).toEqual({tagResolution: "unknown", verificationError: true});
    });

    it("resolves unknown with verificationError:true when rootIssuer is unreadable", async () => {
      const deps = fakeDeps({
        readProfileRoot: vi.fn().mockResolvedValue(A_ROOT),
        readRootIssuer: vi.fn().mockRejectedValue(new Error("RPC timeout")),
      });
      const result = await resolveTagClaim(fakeStore(), deps, {dogTagIdDec: DOG_TAG_ID_DEC, resolvedClientId: "client-1", ourCloneAddress: OUR_CLONE});
      expect(result).toEqual({tagResolution: "unknown", verificationError: true});
    });

    it("resolves unknown with verificationError:true when isValid is unreadable for a foreign clone", async () => {
      const deps = fakeDeps({
        readProfileRoot: vi.fn().mockResolvedValue(A_ROOT),
        readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE),
        readIsValidRoot: vi.fn().mockRejectedValue(new Error("RPC timeout")),
      });
      const result = await resolveTagClaim(fakeStore(), deps, {dogTagIdDec: DOG_TAG_ID_DEC, resolvedClientId: "client-1", ourCloneAddress: OUR_CLONE});
      expect(result).toEqual({tagResolution: "unknown", verificationError: true});
    });
  });

  describe("tier 3: root exists, issuer is OUR clone", () => {
    it('resolves "issued_here_unlinked" (case-insensitively) - possible after a DB restore', async () => {
      const deps = fakeDeps({
        readProfileRoot: vi.fn().mockResolvedValue(A_ROOT),
        readRootIssuer: vi.fn().mockResolvedValue(OUR_CLONE.toUpperCase()),
      });
      const result = await resolveTagClaim(fakeStore(), deps, {dogTagIdDec: DOG_TAG_ID_DEC, resolvedClientId: "client-1", ourCloneAddress: OUR_CLONE});
      expect(result).toEqual({tagResolution: "issued_here_unlinked", issuerClone: OUR_CLONE.toLowerCase(), dogTagIdField: DOG_TAG_ID_FIELD, root: A_ROOT});
      expect(deps.readIsValidRoot).not.toHaveBeenCalled(); // no need to check validity on our own clone for this tier
    });
  });

  describe("tier 4: root exists, issuer is a FOREIGN clone (external)", () => {
    it("resolves external with issuerValid, and does not attempt data verification when no leaves were sent (appointment-only)", async () => {
      const deps = fakeDeps({
        readProfileRoot: vi.fn().mockResolvedValue(A_ROOT),
        readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE),
        readIsValidRoot: vi.fn().mockResolvedValue(true),
      });
      const result = await resolveTagClaim(fakeStore(), deps, {dogTagIdDec: DOG_TAG_ID_DEC, resolvedClientId: "client-1", ourCloneAddress: OUR_CLONE});
      expect(result).toEqual({
        tagResolution: "external",
        issuerClone: FOREIGN_CLONE,
        dogTagIdField: DOG_TAG_ID_FIELD,
        root: A_ROOT,
        issuerValid: true,
        dataVerificationAttempted: false,
        dataVerified: false,
      });
      expect(deps.readIsValidRoot).toHaveBeenCalledWith(FOREIGN_CLONE, A_ROOT);
    });

    it("reports issuerValid:false for a revoked/invalid external root, and never attempts data verification against it", async () => {
      const deps = fakeDeps({
        readProfileRoot: vi.fn().mockResolvedValue(A_ROOT),
        readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE),
        readIsValidRoot: vi.fn().mockResolvedValue(false),
      });
      const leaves: OpenedLeaf[] = [{keyPath: "credentialSubject.species", saltHex: `0x${"11".repeat(16)}`, tag: TypeTag.String, value: "dog"}];
      const reservedLeafHashes = [ZERO_HEX32, ZERO_HEX32, ZERO_HEX32];

      const result = await resolveTagClaim(fakeStore(), deps, {
        dogTagIdDec: DOG_TAG_ID_DEC,
        resolvedClientId: "client-1",
        ourCloneAddress: OUR_CLONE,
        leaves,
        reservedLeafHashes,
      });

      expect(result).toMatchObject({tagResolution: "external", issuerValid: false, dataVerificationAttempted: true, dataVerified: false});
    });

    it("Q3: imports verified attributes when the tag verifies on chain AND the sent leaves recompute to the on-chain root", async () => {
      const {leaves, reservedLeafHashes, root} = buildVerifiableFixture();
      const deps = fakeDeps({
        readProfileRoot: vi.fn().mockResolvedValue(root),
        readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE),
        readIsValidRoot: vi.fn().mockResolvedValue(true),
      });

      const result = await resolveTagClaim(fakeStore(), deps, {
        dogTagIdDec: DOG_TAG_ID_DEC,
        resolvedClientId: "client-1",
        ourCloneAddress: OUR_CLONE,
        leaves,
        reservedLeafHashes,
      });

      expect(result).toMatchObject({
        tagResolution: "external",
        dataVerificationAttempted: true,
        dataVerified: true,
        verifiedAttributes: {species: "dog", breed: "Labrador"},
      });
    });

    it("rejects the import (appointment-only) when the sent leaves do NOT recompute to the on-chain root - never trusts a claimed root", async () => {
      const {leaves, reservedLeafHashes} = buildVerifiableFixture();
      // The on-chain root is something OTHER than what these leaves actually commit to (a
      // mismatched/forged claim) - the whole point of the recompute-and-compare check.
      const wrongRoot = "0x" + "ab".repeat(32);
      const deps = fakeDeps({
        readProfileRoot: vi.fn().mockResolvedValue(wrongRoot),
        readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE),
        readIsValidRoot: vi.fn().mockResolvedValue(true),
      });

      const result = await resolveTagClaim(fakeStore(), deps, {
        dogTagIdDec: DOG_TAG_ID_DEC,
        resolvedClientId: "client-1",
        ourCloneAddress: OUR_CLONE,
        leaves,
        reservedLeafHashes,
      });

      expect(result).toMatchObject({tagResolution: "external", dataVerificationAttempted: true, dataVerified: false});
      expect(result).not.toHaveProperty("verifiedAttributes");
    });

    it("dedupes against an already-imported external pet for the same dogTagIdField instead of importing twice", async () => {
      const {leaves, reservedLeafHashes, root} = buildVerifiableFixture();
      const deps = fakeDeps({
        readProfileRoot: vi.fn().mockResolvedValue(root),
        readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE),
        readIsValidRoot: vi.fn().mockResolvedValue(true),
      });
      const store = fakeStore({findExternalPetByDogTagField: vi.fn().mockResolvedValue({petId: "existing-external-pet"})});

      const result = await resolveTagClaim(store, deps, {
        dogTagIdDec: DOG_TAG_ID_DEC,
        resolvedClientId: "client-1",
        ourCloneAddress: OUR_CLONE,
        leaves,
        reservedLeafHashes,
      });

      expect(result).toMatchObject({tagResolution: "external", dataVerified: true, existingExternalPetId: "existing-external-pet"});
      expect(store.findExternalPetByDogTagField).toHaveBeenCalledWith(DOG_TAG_ID_FIELD);
    });

    it("does not query for an existing external pet at all when data verification was not attempted or failed", async () => {
      const deps = fakeDeps({
        readProfileRoot: vi.fn().mockResolvedValue(A_ROOT),
        readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE),
        readIsValidRoot: vi.fn().mockResolvedValue(true),
      });
      const store = fakeStore();
      await resolveTagClaim(store, deps, {dogTagIdDec: DOG_TAG_ID_DEC, resolvedClientId: "client-1", ourCloneAddress: OUR_CLONE});
      expect(store.findExternalPetByDogTagField).not.toHaveBeenCalled();
    });
  });
});

describe("mapVerifiedLeavesToPetAttributes", () => {
  it("maps known credentialSubject string leaves onto pet attribute fields", () => {
    const saltHex = `0x${"33".repeat(16)}`;
    const leaves: OpenedLeaf[] = [
      {keyPath: "credentialSubject.name", saltHex, tag: TypeTag.String, value: "Rex"},
      {keyPath: "credentialSubject.species", saltHex, tag: TypeTag.String, value: "dog"},
      {keyPath: "credentialSubject.breedLabel", saltHex, tag: TypeTag.String, value: "Labrador Retriever"},
      {keyPath: "credentialSubject.sex", saltHex, tag: TypeTag.String, value: "male"},
      {keyPath: "credentialSubject.dateOfBirth", saltHex, tag: TypeTag.String, value: "2020-01-01"},
    ];
    expect(mapVerifiedLeavesToPetAttributes(leaves)).toEqual({
      name: "Rex",
      species: "dog",
      breed: "Labrador Retriever",
      sex: "male",
      dateOfBirth: "2020-01-01",
    });
  });

  it("falls back to breedVbo when breedLabel is absent", () => {
    const saltHex = `0x${"33".repeat(16)}`;
    const leaves: OpenedLeaf[] = [{keyPath: "credentialSubject.breedVbo", saltHex, tag: TypeTag.String, value: "LAB01"}];
    expect(mapVerifiedLeavesToPetAttributes(leaves).breed).toBe("LAB01");
  });

  it("ignores an invalid sex value rather than propagating garbage onto the pet record", () => {
    const saltHex = `0x${"33".repeat(16)}`;
    const leaves: OpenedLeaf[] = [{keyPath: "credentialSubject.sex", saltHex, tag: TypeTag.String, value: "not-a-real-sex"}];
    expect(mapVerifiedLeavesToPetAttributes(leaves).sex).toBeUndefined();
  });

  it("ignores non-string-tagged leaves for these fields and unrecognized keyPaths", () => {
    const saltHex = `0x${"33".repeat(16)}`;
    const leaves: OpenedLeaf[] = [
      {keyPath: "credentialSubject.species", saltHex, tag: TypeTag.Integer, value: "1"},
      {keyPath: "owner.identity.fullName", saltHex, tag: TypeTag.String, value: "Someone"},
    ];
    expect(mapVerifiedLeavesToPetAttributes(leaves)).toEqual({});
  });

  it("returns an empty object for an empty leaf set", () => {
    expect(mapVerifiedLeavesToPetAttributes([])).toEqual({});
  });
});

/** Builds a genuinely-verifiable (leaves, reservedLeafHashes, root) fixture, mirroring
 * `dogtag-standard-ts/test/profile_bind.test.ts`'s own `computeRoot`/reserved-hash pattern exactly
 * (never a separately-reinvented encoding) - `hashLeaf` + `buildMerkle`, the SAME primitives
 * `verifyLeafCommitment` itself recomputes with. Signs off on its own output by round-tripping
 * through the real `verifyLeafCommitment` before returning, so a bug in this helper fails LOUDLY
 * here rather than producing a fixture that happens to make the real test pass for the wrong
 * reason. Two pet attribute leaves (species + breed) so `mapVerifiedLeavesToPetAttributes`'s
 * output is worth asserting on in the caller. */
function buildVerifiableFixture(): {leaves: OpenedLeaf[]; reservedLeafHashes: string[]; root: string} {
  const salt = (n: number) => new Uint8Array(16).fill(n);
  const saltHexOf = (n: number) => ("0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;

  const leaves: OpenedLeaf[] = [
    {keyPath: "credentialSubject.species", saltHex: saltHexOf(7), tag: TypeTag.String, value: "dog"},
    {keyPath: "credentialSubject.breedLabel", saltHex: saltHexOf(9), tag: TypeTag.String, value: "Labrador"},
  ];
  const reservedLeafHashes = [
    toHex32(hashLeaf("owner.address", salt(201), {tag: TypeTag.Bytes, value: new Uint8Array([1])} as TypedScalar)),
    toHex32(hashLeaf("owner.consentKey", salt(202), {tag: TypeTag.Bytes, value: new Uint8Array([2])} as TypedScalar)),
    toHex32(hashLeaf("owner.secret", salt(203), {tag: TypeTag.Bytes, value: new Uint8Array([3])} as TypedScalar)),
  ];

  const reservedFields = reservedLeafHashes.map((h) => BigInt(h));
  const leafFields = leaves.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), {tag: l.tag, value: l.value} as TypedScalar));
  const root = toHex32(buildMerkle([...reservedFields, ...leafFields]).root);

  const verified = verifyLeafCommitment({root, leaves, reservedLeafHashes, expectedIdentityLeaves: []});
  if (!verified) throw new Error("test fixture bug: constructed root does not verify against its own leaves");

  return {leaves, reservedLeafHashes, root};
}

describe("toBookingIdentity", () => {
  const walletBase = {walletAddress: "0xabc", walletVerified: true, bookingHash: "0xhash", dogTagIdDec: "42"};

  it("maps 'none' to just the base fields, no tier-specific extras", () => {
    expect(toBookingIdentity({...walletBase, tagClaim: {tagResolution: "none"}})).toEqual({...walletBase, tagResolution: "none"});
  });

  it("maps a clean local match with no review-flag fields", () => {
    const result = toBookingIdentity({...walletBase, tagClaim: {tagResolution: "local", petId: "pet-1", needsReview: false}});
    expect(result).toEqual({...walletBase, tagResolution: "local"});
    expect(result).not.toHaveProperty("needsReview");
    expect(result).not.toHaveProperty("candidatePetId");
  });

  it("maps a review-flagged local mismatch with candidatePetId", () => {
    const result = toBookingIdentity({...walletBase, tagClaim: {tagResolution: "local", needsReview: true, candidatePetId: "pet-2"}});
    expect(result).toEqual({...walletBase, tagResolution: "local", needsReview: true, candidatePetId: "pet-2"});
  });

  it("maps unknown with its verificationError flag, both true and false", () => {
    expect(toBookingIdentity({...walletBase, tagClaim: {tagResolution: "unknown", verificationError: true}})).toMatchObject({verificationError: true});
    expect(toBookingIdentity({...walletBase, tagClaim: {tagResolution: "unknown", verificationError: false}})).toMatchObject({verificationError: false});
  });

  it("maps issued_here_unlinked with issuerClone only", () => {
    const result = toBookingIdentity({...walletBase, tagClaim: {tagResolution: "issued_here_unlinked", issuerClone: OUR_CLONE, dogTagIdField: DOG_TAG_ID_FIELD, root: A_ROOT}});
    expect(result).toEqual({...walletBase, tagResolution: "issued_here_unlinked", issuerClone: OUR_CLONE});
  });

  it("maps external with issuerClone/issuerValid/dataVerificationAttempted/dataVerified, never verifiedAttributes or existingExternalPetId (those are for the route to consume, not to persist)", () => {
    const result = toBookingIdentity({
      ...walletBase,
      tagClaim: {
        tagResolution: "external",
        issuerClone: FOREIGN_CLONE,
        dogTagIdField: DOG_TAG_ID_FIELD,
        root: A_ROOT,
        issuerValid: true,
        dataVerificationAttempted: true,
        dataVerified: true,
        verifiedAttributes: {species: "dog"},
        existingExternalPetId: "pet-3",
      },
    });
    expect(result).toEqual({
      ...walletBase,
      tagResolution: "external",
      issuerClone: FOREIGN_CLONE,
      issuerValid: true,
      dataVerificationAttempted: true,
      dataVerified: true,
    });
  });
});
