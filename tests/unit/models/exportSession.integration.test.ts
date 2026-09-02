import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";
import mongoose from "mongoose";
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
 * ISOLATION: own ephemeral mongod, port 44126 (44117-44125 already taken by sibling suites -
 * tests/unit/models/backfill.integration.test.ts's own doc comment has the full registry).
 */
const MONGO_PORT = 44_126;
const CLONE = "0x5bd5048125f223100a2753a740f34d044ab493b";

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-export-session");
  await mongoose.connect(ephemeral.uri);
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  expect(mongoose.connection.name).toBe("dogtag-vet-export-session");
  await ArtifactExportSession.init();
  await TagArtifact.init();
}, 30_000);

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

const ROOT = `0x${"ab".repeat(32)}`;
const NOW = 1_700_000_000;

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
    leaves: [{keyPath: "credentialSubject.name", saltHex: "0x00", tag: 1, value: "Rex"}],
    reservedLeafHashes: [`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`, `0x${"3".repeat(64)}`],
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
});
