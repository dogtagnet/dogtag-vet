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
  mapVerifiedLeavesToPetAttributes,
  resolveTagRootAndIssuer,
  verifyTagDataAgainstRoot,
  type TagDataChainDeps,
} from "@/lib/tags/verifier";

/**
 * Direct unit coverage for the plan-2.3 shared verifier extraction (WP4.9 checklist item 4).
 * `tests/unit/booking/mobileReconcile.test.ts` is the PARITY proof (unmodified, still 29/29 green
 * after the extraction - see wp4.9V-progress.md's LOG); this file tests the extracted functions
 * directly, including the split boundary itself (the `readIsValidRoot`-must-not-be-called case
 * that is the reason this is two functions, not one - see `lib/tags/verifier.ts`'s own doc comment).
 */

const FOREIGN_CLONE = "0x57f8786264c55cdd8f3ece0ba177f6ad2df90e0";
const A_ROOT = `0x${"11".repeat(32)}`;
const DOG_TAG_ID_DEC = "42";
const DOG_TAG_ID_FIELD = dogTagIdField(DOG_TAG_ID_DEC).toString(10);

function fakeDeps(overrides: Partial<TagDataChainDeps> = {}): TagDataChainDeps {
  return {
    readProfileRoot: vi.fn().mockResolvedValue(A_ROOT),
    readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE),
    readIsValidRoot: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

/** Builds a genuine (leaves, reservedLeafHashes, root) triple the real `verifyLeafCommitment`
 * accepts - hashLeaf + buildMerkle, the exact primitives `verifyLeafCommitment` itself recomputes
 * with (same pattern as `tests/unit/booking/mobileReconcile.test.ts`'s own fixture builder and
 * `e2e/mobile-booking.spec.ts`'s `buildVerifiablePetProfile`). */
function buildVerifiableFixture(): {leaves: OpenedLeaf[]; reservedLeafHashes: string[]; root: string} {
  const salt = (n: number) => new Uint8Array(16).fill(n);
  const saltHexOf = (n: number) => ("0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
  const leaves: OpenedLeaf[] = [
    {keyPath: "credentialSubject.species", saltHex: saltHexOf(11), tag: TypeTag.String, value: "dog"},
    {keyPath: "credentialSubject.name", saltHex: saltHexOf(12), tag: TypeTag.String, value: "Rex"},
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

describe("resolveTagRootAndIssuer (shared verifier stage 1)", () => {
  it("resolves dogTagIdField from dogTagIdDec alone", async () => {
    const deps = fakeDeps();
    const result = await resolveTagRootAndIssuer(deps, {dogTagIdDec: DOG_TAG_ID_DEC});
    expect(result).toEqual({ok: true, dogTagIdField: DOG_TAG_ID_FIELD, root: A_ROOT, issuerClone: FOREIGN_CLONE.toLowerCase()});
    expect(deps.readProfileRoot).toHaveBeenCalledWith(DOG_TAG_ID_FIELD);
  });

  it("accepts dogTagIdField alone with no dec to cross-check", async () => {
    const deps = fakeDeps();
    const result = await resolveTagRootAndIssuer(deps, {dogTagIdField: DOG_TAG_ID_FIELD});
    expect(result).toEqual({ok: true, dogTagIdField: DOG_TAG_ID_FIELD, root: A_ROOT, issuerClone: FOREIGN_CLONE.toLowerCase()});
  });

  it("malformed_claim: dogTagIdDec and dogTagIdField both present but inconsistent", async () => {
    const result = await resolveTagRootAndIssuer(fakeDeps(), {dogTagIdDec: DOG_TAG_ID_DEC, dogTagIdField: "999999"});
    expect(result).toEqual({ok: false, reason: "malformed_claim"});
  });

  it("malformed_claim: dogTagIdDec is not a canonical integer", async () => {
    const result = await resolveTagRootAndIssuer(fakeDeps(), {dogTagIdDec: "not-a-number"});
    expect(result).toEqual({ok: false, reason: "malformed_claim"});
  });

  it("chain_unreadable: readProfileRoot throws", async () => {
    const deps = fakeDeps({readProfileRoot: vi.fn().mockRejectedValue(new Error("RPC timeout"))});
    const result = await resolveTagRootAndIssuer(deps, {dogTagIdDec: DOG_TAG_ID_DEC});
    expect(result).toEqual({ok: false, reason: "chain_unreadable"});
  });

  it("chain_unreadable: readRootIssuer throws", async () => {
    const deps = fakeDeps({readRootIssuer: vi.fn().mockRejectedValue(new Error("RPC timeout"))});
    const result = await resolveTagRootAndIssuer(deps, {dogTagIdDec: DOG_TAG_ID_DEC});
    expect(result).toEqual({ok: false, reason: "chain_unreadable"});
    // Root read succeeded and was nonzero - rootIssuer SHOULD have been attempted.
    expect(deps.readRootIssuer).toHaveBeenCalledWith(A_ROOT);
  });

  it("root_unset: profileRoot reads back as the zero hash", async () => {
    const deps = fakeDeps({readProfileRoot: vi.fn().mockResolvedValue(`0x${"0".repeat(64)}`)});
    const result = await resolveTagRootAndIssuer(deps, {dogTagIdDec: DOG_TAG_ID_DEC});
    expect(result).toEqual({ok: false, reason: "root_unset"});
    expect(deps.readRootIssuer).not.toHaveBeenCalled();
  });

  it("issuer_unknown: nonzero root but zero rootIssuer (defensive, should never occur on a consistent chain)", async () => {
    const deps = fakeDeps({readRootIssuer: vi.fn().mockResolvedValue("0x0000000000000000000000000000000000000000")});
    const result = await resolveTagRootAndIssuer(deps, {dogTagIdDec: DOG_TAG_ID_DEC});
    expect(result).toEqual({ok: false, reason: "issuer_unknown"});
  });

  it("issuerClone is lowercased regardless of the chain read's own casing", async () => {
    const deps = fakeDeps({readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE.toUpperCase())});
    const result = await resolveTagRootAndIssuer(deps, {dogTagIdDec: DOG_TAG_ID_DEC});
    expect(result).toEqual({ok: true, dogTagIdField: DOG_TAG_ID_FIELD, root: A_ROOT, issuerClone: FOREIGN_CLONE.toLowerCase()});
  });
});

describe("verifyTagDataAgainstRoot (shared verifier stage 2)", () => {
  it("no data sent: dataVerificationAttempted false, dataVerified false, isValid still read", async () => {
    const deps = fakeDeps();
    const result = await verifyTagDataAgainstRoot(deps, {issuerClone: FOREIGN_CLONE, root: A_ROOT});
    expect(result).toEqual({ok: true, issuerValid: true, dataVerificationAttempted: false, dataVerified: false});
    expect(deps.readIsValidRoot).toHaveBeenCalledWith(FOREIGN_CLONE, A_ROOT);
  });

  it("chain_unreadable: readIsValidRoot throws", async () => {
    const deps = fakeDeps({readIsValidRoot: vi.fn().mockRejectedValue(new Error("RPC timeout"))});
    const result = await verifyTagDataAgainstRoot(deps, {issuerClone: FOREIGN_CLONE, root: A_ROOT});
    expect(result).toEqual({ok: false});
  });

  it("issuer invalid (revoked or foreign-invalid): data verification is never attempted even if data was sent", async () => {
    const {leaves, reservedLeafHashes, root} = buildVerifiableFixture();
    const deps = fakeDeps({readIsValidRoot: vi.fn().mockResolvedValue(false)});
    const result = await verifyTagDataAgainstRoot(deps, {issuerClone: FOREIGN_CLONE, root, leaves, reservedLeafHashes});
    expect(result).toEqual({ok: true, issuerValid: false, dataVerificationAttempted: true, dataVerified: false});
  });

  it("issuer valid + genuine leaves: dataVerified true with verifiedAttributes populated", async () => {
    const {leaves, reservedLeafHashes, root} = buildVerifiableFixture();
    const deps = fakeDeps();
    const result = await verifyTagDataAgainstRoot(deps, {issuerClone: FOREIGN_CLONE, root, leaves, reservedLeafHashes});
    expect(result).toEqual({
      ok: true,
      issuerValid: true,
      dataVerificationAttempted: true,
      dataVerified: true,
      verifiedAttributes: {species: "dog", name: "Rex"},
    });
  });

  it("issuer valid + tampered leaves: dataVerified false, no verifiedAttributes", async () => {
    const {leaves, reservedLeafHashes, root} = buildVerifiableFixture();
    const tampered = leaves.map((l) => (l.keyPath === "credentialSubject.name" ? {...l, value: "Max"} : l));
    const deps = fakeDeps();
    const result = await verifyTagDataAgainstRoot(deps, {issuerClone: FOREIGN_CLONE, root, leaves: tampered, reservedLeafHashes});
    expect(result).toEqual({ok: true, issuerValid: true, dataVerificationAttempted: true, dataVerified: false});
  });

  it("only leaves sent, no reservedLeafHashes: dataVerificationAttempted stays false", async () => {
    const {leaves} = buildVerifiableFixture();
    const deps = fakeDeps();
    const result = await verifyTagDataAgainstRoot(deps, {issuerClone: FOREIGN_CLONE, root: A_ROOT, leaves});
    expect(result).toEqual({ok: true, issuerValid: true, dataVerificationAttempted: false, dataVerified: false});
  });
});

describe("mapVerifiedLeavesToPetAttributes (re-exported, exercised directly from lib/tags/verifier)", () => {
  it("maps a genuine leaf set's string attributes", () => {
    const {leaves} = buildVerifiableFixture();
    expect(mapVerifiedLeavesToPetAttributes(leaves)).toEqual({species: "dog", name: "Rex"});
  });
});
