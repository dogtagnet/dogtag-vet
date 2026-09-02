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
import {backfillTagArtifacts} from "@/lib/tags/backfill";
import {mongoBackfillStore} from "@/lib/tags/backfillMongoAdapter";
import {Pet} from "@/lib/models/Pet";
import {MintSession} from "@/lib/models/MintSession";
import {TagArtifact} from "@/lib/models/TagArtifact";

/**
 * WP4.9 checklist item 3c's own explicit requirement - "tested against scratchpad DB fixtures incl.
 * a corrupted-session report case" - against a REAL, disposable ephemeral mongod (never the live
 * manual-E2E database on 127.0.0.1:27500; never run via this suite against anything but this file's
 * own throwaway instance). Proves the PRODUCTION adapter (`mongoBackfillStore`) end to end, not just
 * `backfillTagArtifacts`'s pure logic (already covered by tests/unit/tags/backfill.test.ts's
 * in-memory-fake suite).
 *
 * CRITICAL LIVE-DB RULE (wp4.9V-progress.md's own header): this test file never sets
 * `process.env.MONGODB_URI` and never calls `connectToDatabase()` - it connects `mongoose`'s
 * default connection directly to its own ephemeral instance, the same pattern
 * `staleModelRepro.integration.test.ts` and `tagArtifact.integration.test.ts` already use, with the
 * same hard host/port/name safety-net assertions right after connecting.
 *
 * ISOLATION: own ephemeral mongod, port 44125 (44117-44124 already taken by sibling suites).
 */

const MONGO_PORT = 44_125;

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-backfill");
  await mongoose.connect(ephemeral.uri);
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  expect(mongoose.connection.name).toBe("dogtag-vet-backfill");
  await TagArtifact.init();
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Promise.all([Pet.deleteMany({}), MintSession.deleteMany({}), TagArtifact.deleteMany({})]);
});

const CLONE = "0x5BD5048125F223100A2753A740F34D044AB493B";
const DOG_TAG_ID_DEC = "42";
const DOG_TAG_ID_FIELD = dogTagIdField(DOG_TAG_ID_DEC).toString(10);

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

async function seedBoundPet(petId: string, fixture: ReturnType<typeof buildVerifiableFixture>, options: {external?: boolean} = {}) {
  await Pet.create({
    petId,
    name: "Test Pet",
    ownerClientIds: [],
    dogTag: {
      dogTagIdDec: DOG_TAG_ID_DEC,
      dogTagIdField: DOG_TAG_ID_FIELD,
      root: fixture.root,
      status: "active",
      cloneAddress: CLONE,
      external: options.external,
    },
    searchKey: "test pet",
  });
  await MintSession.create({
    dogTagIdDec: DOG_TAG_ID_DEC,
    dogTagIdField: DOG_TAG_ID_FIELD,
    identityLeaves: [],
    petId,
    petName: "Test Pet",
    profile: {weightHistory: []},
    status: "bound",
    root: fixture.root,
    boundLeaves: fixture.leaves,
    reservedLeafHashes: fixture.reservedLeafHashes,
    protocolVersion: "dogtag-v2/1",
    tokenExp: 9_999_999_999,
  });
}

describe("backfillTagArtifacts against a real ephemeral mongod", () => {
  it("inserts a genuine TagArtifact for a pet+session pair, then is a true no-op on a re-run (idempotent)", async () => {
    const fixture = buildVerifiableFixture();
    await seedBoundPet("pet-1", fixture);

    const first = await backfillTagArtifacts(mongoBackfillStore, 1_700_000_000);
    expect(first).toMatchObject({scanned: 1, alreadyCovered: 0, inserted: 1, mismatches: []});

    const stored = await TagArtifact.findOne({petId: "pet-1"}).lean();
    expect(stored?.root).toBe(fixture.root.toLowerCase());
    expect(stored?.active).toBe(true);
    expect(stored?.source).toBe("issued_here");
    expect(stored?.leaves).toEqual(fixture.leaves.map((l) => ({keyPath: l.keyPath, saltHex: l.saltHex, tag: l.tag, value: l.value})));

    const second = await backfillTagArtifacts(mongoBackfillStore, 1_700_000_100);
    expect(second).toMatchObject({scanned: 1, alreadyCovered: 1, inserted: 0, mismatches: []});
    expect(await TagArtifact.countDocuments({})).toBe(1); // still exactly one row - no duplicate
  });

  it("the corrupted-session report case: a real MintSession whose stored leaves no longer recompute its own claimed root is reported, never auto-fixed, and nothing is written", async () => {
    const fixture = buildVerifiableFixture();
    await Pet.create({
      petId: "pet-corrupted",
      name: "Corrupted Pet",
      ownerClientIds: [],
      dogTag: {dogTagIdDec: DOG_TAG_ID_DEC, dogTagIdField: DOG_TAG_ID_FIELD, root: fixture.root, status: "active", cloneAddress: CLONE},
      searchKey: "corrupted pet",
    });
    // Corruption, written directly (simulating data damage/tampering after the original bind): the
    // session still CLAIMS `fixture.root`, but its boundLeaves have one value altered.
    const corruptedLeaves = fixture.leaves.map((l) => (l.keyPath === "credentialSubject.name" ? {...l, value: "TAMPERED"} : l));
    await MintSession.create({
      dogTagIdDec: DOG_TAG_ID_DEC,
      dogTagIdField: DOG_TAG_ID_FIELD,
      identityLeaves: [],
      petId: "pet-corrupted",
      petName: "Corrupted Pet",
      profile: {weightHistory: []},
      status: "bound",
      root: fixture.root,
      boundLeaves: corruptedLeaves,
      reservedLeafHashes: fixture.reservedLeafHashes,
      protocolVersion: "dogtag-v2/1",
      tokenExp: 9_999_999_999,
    });

    const report = await backfillTagArtifacts(mongoBackfillStore, 1_700_000_000);
    expect(report).toMatchObject({scanned: 1, inserted: 0});
    expect(report.mismatches).toEqual([
      {petId: "pet-corrupted", root: fixture.root, reason: "this session's stored root/leaves no longer recompute (leaf_commitment_invalid)"},
    ]);
    expect(await TagArtifact.countDocuments({})).toBe(0);

    // Re-running does not "fix" it either - report is byte-identical, nothing was ever written.
    const rerun = await backfillTagArtifacts(mongoBackfillStore, 1_700_000_200);
    expect(rerun.mismatches).toEqual(report.mismatches);
    expect(await TagArtifact.countDocuments({})).toBe(0);
  });

  it("reports a mismatch (never crashes) when a pet's dogTag.root has no MintSession on file at all", async () => {
    await Pet.create({
      petId: "pet-orphan",
      name: "Orphan Pet",
      ownerClientIds: [],
      dogTag: {dogTagIdDec: "99", dogTagIdField: "999999", root: `0x${"9".repeat(64)}`, status: "active", cloneAddress: CLONE},
      searchKey: "orphan pet",
    });
    const report = await backfillTagArtifacts(mongoBackfillStore, 1_700_000_000);
    expect(report.mismatches).toEqual([
      {petId: "pet-orphan", root: `0x${"9".repeat(64)}`, reason: "no MintSession on file carries this pet's dogTag.root"},
    ]);
    expect(await TagArtifact.countDocuments({})).toBe(0);
  });

  it("imports correctly for an external pet: source is 'imported', self-check identity subset used", async () => {
    const fixture = buildVerifiableFixture();
    await seedBoundPet("pet-external", fixture, {external: true});
    const report = await backfillTagArtifacts(mongoBackfillStore, 1_700_000_000);
    expect(report.inserted).toBe(1);
    const stored = await TagArtifact.findOne({petId: "pet-external"}).lean();
    expect(stored?.source).toBe("imported");
  });

  it("dryRun against real data: predicts correctly and writes NOTHING", async () => {
    const fixture = buildVerifiableFixture();
    await seedBoundPet("pet-dry", fixture);
    const report = await backfillTagArtifacts(mongoBackfillStore, 1_700_000_000, {dryRun: true});
    expect(report).toMatchObject({dryRun: true, inserted: 1});
    expect(await TagArtifact.countDocuments({})).toBe(0);
  });

  it("skips pets with no dogTag.root at all (never issued/imported)", async () => {
    await Pet.create({petId: "pet-untagged", name: "Untagged", ownerClientIds: [], dogTag: {}, searchKey: "untagged"});
    const report = await backfillTagArtifacts(mongoBackfillStore, 1_700_000_000);
    expect(report.scanned).toBe(0);
  });
});
