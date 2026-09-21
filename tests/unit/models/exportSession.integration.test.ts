import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";
import mongoose from "mongoose";
import {buildMerkle, hashLeaf, hexToBytes, toHex32, TypeTag, type TypedScalar} from "@dogtag/standard";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";
import {resolveAndConsumeExport} from "@/lib/tags/exportFlow";
import {mongoExportStore} from "@/lib/tags/exportMongoAdapter";
import {ArtifactExportSession} from "@/lib/models/ArtifactExportSession";
import {TagArtifact} from "@/lib/models/TagArtifact";
import {Pet} from "@/lib/models/Pet";
import {ClinicSettings} from "@/lib/models/ClinicSettings";

/**
 * `mongoExportStore` end to end against a REAL ephemeral mongod - proves two things an in-memory
 * fake (`tests/unit/tags/exportFlow.test.ts`) cannot: the production adapter's own query shapes are
 * correct, and `tryConsume`'s atomic `findOneAndUpdate` genuinely resolves a real concurrent race
 * (never the live manual-E2E database on 127.0.0.1:27500 - see this repo's own CRITICAL LIVE-DB
 * RULE, plans/orchestration/wp4.9V-progress.md).
 *
 * ISOLATION: own ephemeral mongod on a freshly OS-reserved free port (see
 * tests/unit/helpers/ephemeralMongod.ts - each spawn reserves a currently-free port by binding
 * and releasing a throwaway socket, unique across concurrent processes including two whole
 * copies of this suite running at once, and retries on a genuine bind collision, so no fixed
 * port or manual coordination between sibling suites is needed).
 */
const CLONE = "0x5bd5048125f223100a2753a740f34d044ab493b";

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod("dogtag-vet-export-session");
  await mongoose.connect(ephemeral.uri);
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(ephemeral.port);
  expect(mongoose.connection.name).toBe("dogtag-vet-export-session");
  await ArtifactExportSession.init();
  await TagArtifact.init();
}, 90_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Promise.all([
    Pet.deleteMany({}),
    TagArtifact.deleteMany({}),
    ArtifactExportSession.deleteMany({}),
    ClinicSettings.deleteMany({}),
  ]);
});

const NOW = 1_700_000_000;

/** A genuine, hashLeaf/buildMerkle-verifiable fixture - WP4.10V item 3's self-check
 * (`resolveAndConsumeExport` now runs `verifyRedactedArtifact` before serving) means a placeholder
 * root/leaves pair (fine before this wave, since nothing here ever recomputed it) now makes every
 * fetch fail as `internal_error`. Mirrors `tests/unit/tags/backfill.test.ts`'s own
 * `buildVerifiableFixture` convention. */
const LEAVES = [{keyPath: "credentialSubject.name", saltHex: `0x${"aa".repeat(16)}`, tag: TypeTag.String, value: "Rex"}];
const RESERVED_LEAF_HASHES = [
  toHex32(hashLeaf("owner.address", new Uint8Array(16).fill(1), {tag: TypeTag.Bytes, value: new Uint8Array([1])} as TypedScalar)),
  toHex32(hashLeaf("owner.consentKey", new Uint8Array(16).fill(2), {tag: TypeTag.Bytes, value: new Uint8Array([2])} as TypedScalar)),
  toHex32(hashLeaf("owner.secret", new Uint8Array(16).fill(3), {tag: TypeTag.Bytes, value: new Uint8Array([3])} as TypedScalar)),
];
const ROOT = toHex32(
  buildMerkle([
    ...RESERVED_LEAF_HASHES.map((h) => BigInt(h)),
    ...LEAVES.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), {tag: l.tag, value: l.value} as TypedScalar)),
  ]).root,
);

async function seedActivePetAndArtifact(petId: string, options: {dogTagStatus?: "active" | "revoked"} = {}) {
  await Pet.create({
    petId,
    name: "Rex",
    ownerClientIds: [],
    dogTag: {dogTagIdDec: "42", dogTagIdField: "999999", root: ROOT, status: options.dogTagStatus ?? "active", cloneAddress: CLONE},
    searchKey: "rex",
  });
  await TagArtifact.create({
    petId,
    dogTagIdDec: "42",
    dogTagIdField: "999999",
    root: ROOT,
    protocolVersion: "dogtag-v2/1",
    leaves: LEAVES,
    reservedLeafHashes: RESERVED_LEAF_HASHES,
    source: "issued_here",
    issuerClone: CLONE,
    verifiedAt: NOW,
    active: true,
  });
}

describe("mongoExportStore + resolveAndConsumeExport against a real ephemeral mongod", () => {
  it("happy path end to end: real session, real artifact, real pet", async () => {
    await seedActivePetAndArtifact("pet-1");
    await ClinicSettings.create({_id: "singleton", businessProfile: {name: "Example Vet Clinic"}});
    const session = await ArtifactExportSession.create({token: "a".repeat(32), petId: "pet-1", root: ROOT, exp: NOW + 600});

    const result = await resolveAndConsumeExport(mongoExportStore, session.token, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.petName).toBe("Rex");
      expect(result.data.clinicName).toBe("Example Vet Clinic");
      expect(result.data.root).toBe(ROOT);
      expect(result.data.issuerClone).toBe(CLONE);
    }

    const stored = await ArtifactExportSession.findOne({token: session.token}).lean();
    expect(stored?.usedAt).toBe(NOW);
  });

  it("a REAL concurrent race: exactly one of two simultaneous fetches gets the payload, the other is expired_or_reused", async () => {
    await seedActivePetAndArtifact("pet-race");
    const session = await ArtifactExportSession.create({token: "b".repeat(32), petId: "pet-race", root: ROOT, exp: NOW + 600});

    const [first, second] = await Promise.all([
      resolveAndConsumeExport(mongoExportStore, session.token, NOW),
      resolveAndConsumeExport(mongoExportStore, session.token, NOW),
    ]);
    const outcomes = [first, second];
    const winners = outcomes.filter((r) => r.ok);
    const losers = outcomes.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toEqual({ok: false, code: "expired_or_reused"});
  });

  it("superseded: the artifact this session names has since been replaced (active: false)", async () => {
    await seedActivePetAndArtifact("pet-superseded");
    await TagArtifact.updateOne({petId: "pet-superseded"}, {$set: {active: false, supersededByRoot: `0x${"cd".repeat(32)}`}});
    const session = await ArtifactExportSession.create({token: "c".repeat(32), petId: "pet-superseded", root: ROOT, exp: NOW + 600});

    const result = await resolveAndConsumeExport(mongoExportStore, session.token, NOW);
    expect(result).toEqual({ok: false, code: "superseded"});
  });

  it("revoked: the pet's tag status is revoked", async () => {
    await seedActivePetAndArtifact("pet-revoked", {dogTagStatus: "revoked"});
    const session = await ArtifactExportSession.create({token: "d".repeat(32), petId: "pet-revoked", root: ROOT, exp: NOW + 600});

    const result = await resolveAndConsumeExport(mongoExportStore, session.token, NOW);
    expect(result).toEqual({ok: false, code: "revoked"});
  });

  it("not_found for a token no session was ever created for", async () => {
    const result = await resolveAndConsumeExport(mongoExportStore, "e".repeat(32), NOW);
    expect(result).toEqual({ok: false, code: "not_found"});
  });

  it("expired_or_reused past the TTL", async () => {
    await seedActivePetAndArtifact("pet-expired");
    const session = await ArtifactExportSession.create({token: "f".repeat(32), petId: "pet-expired", root: ROOT, exp: NOW - 1});
    const result = await resolveAndConsumeExport(mongoExportStore, session.token, NOW);
    expect(result).toEqual({ok: false, code: "expired_or_reused"});
  });

  it("WP4.10V item 3: a session's real, persisted mask is threaded through by the production adapter end to end", async () => {
    await seedActivePetAndArtifact("pet-masked");
    const session = await ArtifactExportSession.create({
      token: "g".repeat(32),
      petId: "pet-masked",
      root: ROOT,
      exp: NOW + 600,
      mask: ["credentialSubject.name"],
    });

    const result = await resolveAndConsumeExport(mongoExportStore, session.token, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.disclosed).toEqual([]);
    expect(result.data.obfuscatedLeafHashes).toEqual([
      toHex32(hashLeaf(LEAVES[0]!.keyPath, hexToBytes(LEAVES[0]!.saltHex), {tag: LEAVES[0]!.tag, value: LEAVES[0]!.value} as TypedScalar)),
    ]);
  });

  it("a legacy artifact with NO obfuscatedLeafHashes key at all (the mongo adapter's own .lean() normalization) still exports successfully", async () => {
    // Bypasses Mongoose entirely, same technique as tagArtifact.integration.test.ts's own legacy-row
    // test - a schema default only ever applies at document construction, never to a document that
    // was already sitting in the collection before the field existed.
    await Pet.create({
      petId: "pet-legacy-export",
      name: "Legacy",
      ownerClientIds: [],
      dogTag: {dogTagIdDec: "42", dogTagIdField: "999999", root: ROOT, status: "active", cloneAddress: CLONE},
      searchKey: "legacy",
    });
    await TagArtifact.collection.insertOne({
      artifactId: "legacy-export-artifact",
      petId: "pet-legacy-export",
      dogTagIdDec: "42",
      dogTagIdField: "999999",
      root: ROOT,
      protocolVersion: "dogtag-v2/1",
      leaves: LEAVES,
      reservedLeafHashes: RESERVED_LEAF_HASHES,
      source: "issued_here",
      issuerClone: CLONE,
      verifiedAt: NOW,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      // deliberately no obfuscatedLeafHashes key, no schemaId key.
    });
    const session = await ArtifactExportSession.create({token: "h".repeat(32), petId: "pet-legacy-export", root: ROOT, exp: NOW + 600});

    const result = await resolveAndConsumeExport(mongoExportStore, session.token, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.obfuscatedLeafHashes).toEqual([]);
    expect(result.data.disclosed).toEqual(LEAVES);
    expect(result.data.schemaId).toBeUndefined();
  });
});
