import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";
import mongoose from "mongoose";
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
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";
import {createTagArtifact, findActiveTagArtifact, supersedeActiveArtifactsForPet, type CreateTagArtifactInput} from "@/lib/tags/artifact";
import {TagArtifact} from "@/lib/models/TagArtifact";

/**
 * WP4.9 item 2 - the TagArtifact write-helper invariant, against a REAL ephemeral mongod (needed
 * for the unique `root` index and `updateMany` semantics an in-memory fake can't reproduce - same
 * rationale as every other `.integration.test.ts` in this repo, `ephemeralMongod.ts`'s own doc
 * comment).
 *
 * ISOLATION: own ephemeral mongod, port 44124 (44117-44123 already taken by sibling suites - see
 * each file's own ISOLATION note). Never `process.env.MONGODB_URI`, never 127.0.0.1:27500.
 */

const MONGO_PORT = 44_124;

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-tag-artifact");
  await mongoose.connect(ephemeral.uri);
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  expect(mongoose.connection.name).toBe("dogtag-vet-tag-artifact");
  // The unique `root` index builds in the background on model compilation - wait for it before any
  // test relies on it rejecting a duplicate.
  await TagArtifact.init();
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await TagArtifact.deleteMany({});
});

const ISSUER_CLONE = "0x5BD5048125F223100A2753A740F34D044AB493B"; // deliberately mixed-case
const DOG_TAG_ID_DEC = "42";
const DOG_TAG_ID_FIELD = dogTagIdField(DOG_TAG_ID_DEC).toString(10);

/** Genuine (leaves, reservedLeafHashes, root) triple - hashLeaf + buildMerkle, the exact primitives
 * `verifyLeafCommitment` itself recomputes with (same fixture-building convention as
 * `tests/unit/tags/verifier.test.ts` and `tests/unit/booking/mobileReconcile.test.ts`). */
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

function baseInput(overrides: Partial<CreateTagArtifactInput> = {}): CreateTagArtifactInput {
  const {leaves, reservedLeafHashes, root} = buildVerifiableFixture();
  return {
    petId: "pet-1",
    dogTagIdDec: DOG_TAG_ID_DEC,
    dogTagIdField: DOG_TAG_ID_FIELD,
    root,
    protocolVersion: "dogtag-v2/1",
    schemaId: "https://dogtag.io/schemas/dog-profile/v1",
    leaves,
    reservedLeafHashes,
    expectedIdentityLeaves: [],
    source: "issued_here",
    issuerClone: ISSUER_CLONE,
    now: 1_700_000_000,
    ...overrides,
  };
}

describe("createTagArtifact - the invariant (accept/refuse)", () => {
  it("accepts a genuinely verifiable insert and stores every field, root/issuerClone lowercased", async () => {
    const input = baseInput();
    const result = await createTagArtifact(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.artifact.petId).toBe("pet-1");
    expect(result.artifact.root).toBe(input.root.toLowerCase());
    expect(result.artifact.issuerClone).toBe(ISSUER_CLONE.toLowerCase());
    expect(result.artifact.active).toBe(true);
    expect(result.artifact.verifiedAt).toBe(1_700_000_000);
    expect(result.artifact.leaves).toEqual(input.leaves.map((l) => ({keyPath: l.keyPath, saltHex: l.saltHex, tag: l.tag, value: l.value})));
    expect(result.artifact.reservedLeafHashes).toEqual(input.reservedLeafHashes);
    expect(result.artifact.schemaId).toBe("https://dogtag.io/schemas/dog-profile/v1");

    expect(await TagArtifact.countDocuments({})).toBe(1);
  });

  it("refuses (no insert) when the leaves are tampered - root no longer recomputes", async () => {
    const {leaves, reservedLeafHashes, root} = buildVerifiableFixture();
    const tampered = leaves.map((l) => (l.keyPath === "credentialSubject.name" ? {...l, value: "Max"} : l));
    const result = await createTagArtifact(baseInput({leaves: tampered, reservedLeafHashes, root}));
    expect(result).toEqual({ok: false, reason: "leaf_commitment_invalid"});
    expect(await TagArtifact.countDocuments({})).toBe(0);
  });

  it("refuses on an unsupported protocol version", async () => {
    const result = await createTagArtifact(baseInput({protocolVersion: "dogtag-v3/1"}));
    expect(result).toEqual({ok: false, reason: "unsupported_protocol_version"});
    expect(await TagArtifact.countDocuments({})).toBe(0);
  });

  it("a refused insert (tampered leaves) never supersedes the pet's existing active artifact", async () => {
    const first = await createTagArtifact(baseInput());
    expect(first.ok).toBe(true);

    const {leaves, reservedLeafHashes, root} = buildVerifiableFixture("Different");
    const tampered = leaves.map((l) => (l.keyPath === "credentialSubject.name" ? {...l, value: "Tampered"} : l));
    const second = await createTagArtifact(baseInput({leaves: tampered, reservedLeafHashes, root}));
    expect(second.ok).toBe(false);

    const active = await findActiveTagArtifact("pet-1");
    expect(active?.root).toBe((first.ok ? first.artifact.root : "")); // the FIRST artifact is still active, untouched
  });

  it("a refused insert (unsupported protocol version) never supersedes the pet's existing active artifact", async () => {
    const first = await createTagArtifact(baseInput());
    expect(first.ok).toBe(true);

    const second = await createTagArtifact(baseInput({...buildVerifiableFixture("Different"), protocolVersion: "dogtag-v3/1"}));
    expect(second.ok).toBe(false);

    expect(await TagArtifact.countDocuments({active: true})).toBe(1);
    const active = await findActiveTagArtifact("pet-1");
    expect(active?.active).toBe(true);
  });

  it("reissue: a second successful create for the same pet supersedes the first (exactly one active remains)", async () => {
    const first = await createTagArtifact(baseInput());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");

    const {leaves, reservedLeafHashes, root} = buildVerifiableFixture("Rex II");
    const second = await createTagArtifact(baseInput({leaves, reservedLeafHashes, root}));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");

    expect(await TagArtifact.countDocuments({petId: "pet-1"})).toBe(2);
    expect(await TagArtifact.countDocuments({petId: "pet-1", active: true})).toBe(1);

    const supersededFirst = await TagArtifact.findOne({root: first.artifact.root}).lean();
    expect(supersededFirst?.active).toBe(false);
    expect(supersededFirst?.supersededByRoot).toBe(second.artifact.root);

    const activeSecond = await findActiveTagArtifact("pet-1");
    expect(activeSecond?.root).toBe(second.artifact.root);
  });

  it("the root unique index rejects a genuine duplicate root (defense in depth beyond the write helper)", async () => {
    const input = baseInput();
    const first = await createTagArtifact(input);
    expect(first.ok).toBe(true);
    // Same root, different pet - createTagArtifact itself does not de-dupe across pets; the unique
    // index is the backstop. A caller hitting this in practice indicates a genuine bug upstream
    // (two different pets computing the identical root is not supposed to be possible).
    await expect(createTagArtifact({...input, petId: "pet-2"})).rejects.toThrow(/duplicate key|E11000/i);
  });
});

describe("supersedeActiveArtifactsForPet", () => {
  it("is a no-op when the pet has no active artifact yet", async () => {
    await expect(supersedeActiveArtifactsForPet("pet-none", "0xdead")).resolves.toBeUndefined();
    expect(await TagArtifact.countDocuments({})).toBe(0);
  });

  it("flips EVERY active row for the pet, not just one, given more than one somehow exists (bad-data defense)", async () => {
    const {leaves: leavesA, reservedLeafHashes: reservedA, root: rootA} = buildVerifiableFixture("A");
    const {leaves: leavesB, reservedLeafHashes: reservedB, root: rootB} = buildVerifiableFixture("B");
    // Bypasses the write helper deliberately, to construct the "bad data" precondition (two active
    // rows for one pet) the helper itself should never produce but must tolerate if it is ever
    // found - see the function's own doc comment.
    await TagArtifact.create({
      petId: "pet-bad",
      dogTagIdDec: DOG_TAG_ID_DEC,
      dogTagIdField: DOG_TAG_ID_FIELD,
      root: rootA,
      protocolVersion: "dogtag-v2/1",
      leaves: leavesA,
      reservedLeafHashes: reservedA,
      source: "issued_here",
      issuerClone: ISSUER_CLONE.toLowerCase(),
      verifiedAt: 1,
      active: true,
    });
    await TagArtifact.create({
      petId: "pet-bad",
      dogTagIdDec: DOG_TAG_ID_DEC,
      dogTagIdField: DOG_TAG_ID_FIELD,
      root: rootB,
      protocolVersion: "dogtag-v2/1",
      leaves: leavesB,
      reservedLeafHashes: reservedB,
      source: "issued_here",
      issuerClone: ISSUER_CLONE.toLowerCase(),
      verifiedAt: 2,
      active: true,
    });
    expect(await TagArtifact.countDocuments({petId: "pet-bad", active: true})).toBe(2);

    await supersedeActiveArtifactsForPet("pet-bad", "0xnewroot");

    expect(await TagArtifact.countDocuments({petId: "pet-bad", active: true})).toBe(0);
    const rows = await TagArtifact.find({petId: "pet-bad"}).lean();
    expect(rows.every((r) => r.active === false && r.supersededByRoot === "0xnewroot")).toBe(true);
  });
});

describe("findActiveTagArtifact", () => {
  it("returns null when the pet has no artifact", async () => {
    expect(await findActiveTagArtifact("nobody")).toBeNull();
  });

  it("returns the active row, never a superseded one", async () => {
    const first = await createTagArtifact(baseInput());
    expect(first.ok).toBe(true);
    const {leaves, reservedLeafHashes, root} = buildVerifiableFixture("Rex II");
    const second = await createTagArtifact(baseInput({leaves, reservedLeafHashes, root}));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");

    const active = await findActiveTagArtifact("pet-1");
    expect(active?.root).toBe(second.artifact.root);
  });
});
