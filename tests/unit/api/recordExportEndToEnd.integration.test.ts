import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {buildMerkle, hashLeaf, hexToBytes, toHex32, TypeTag, type TypedScalar} from "@dogtag/standard";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * Plan section 11.2 V5's own explicit demand: "the tag path unchanged (byte-identical for
 * artifactType tag; `leaves` alias intact - must be asserted in a test)". `/e/[token]/route.ts` now
 * dispatches on `peekExportSessionArtifactType` BEFORE calling into either ceremony - this file
 * proves that dispatch never changes what a genuine TAG session's `GET /e/:token` response looks
 * like (calling the REAL route handler, not just the pure `resolveAndConsumeExport` function
 * `tests/unit/models/exportSession.integration.test.ts` already covers), and separately proves the
 * NEW record path produces the `RecordArtifact`-shaped response `specs/vet-public-api.yaml`'s
 * `ArtifactExportResponse` describes.
 *
 * ISOLATION: own ephemeral mongod, port 44139 (44117-44138 already taken by sibling suites).
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));

import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {Staff} from "@/lib/models/Staff";
import {Pet} from "@/lib/models/Pet";
import {ClinicSettings} from "@/lib/models/ClinicSettings";
import {TagArtifact} from "@/lib/models/TagArtifact";
import {RecordArtifact, type RecordArtifactDoc} from "@/lib/models/RecordArtifact";
import {ArtifactExportSession} from "@/lib/models/ArtifactExportSession";
import {buildVaccinationRecord, VACCINATION_SCHEMA_ID, VACCINATION_SCHEMA_VERSION} from "@/lib/records/build";
import {resolveAndConsumeRecordExport} from "@/lib/records/exportFlow";
import {mongoRecordExportStore} from "@/lib/records/exportMongoAdapter";
import {GET as exportTokenGET} from "@/app/e/[token]/route";
import {POST as recordExportPOST} from "@/app/api/pets/[id]/records/[recordId]/export/route";

const MONGO_PORT = 44_139;
const CLONE = "0x0000000000000000000000000000000000c10be5";
const OPERATOR = "0x0000000000000000000000000000000000000ff1";

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-record-export-e2e");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  await ArtifactExportSession.init();
  await RecordArtifact.init();
}, 30_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Promise.all([
    Staff.deleteMany({}),
    Pet.deleteMany({}),
    ClinicSettings.deleteMany({}),
    TagArtifact.deleteMany({}),
    RecordArtifact.deleteMany({}),
    ArtifactExportSession.deleteMany({}),
  ]);
  vi.mocked(auth).mockReset();
});

async function withStaffSession(): Promise<void> {
  const staff = await Staff.create({email: `vet-${randomUUID()}@example.com`, role: "vet", firstName: "Jane", lastName: "Tan"});
  vi.mocked(auth).mockResolvedValue({user: {staffId: staff.staffId}} as never);
}

function tokenParams(token: string): {params: Promise<{token: string}>} {
  return {params: Promise.resolve({token})};
}

// --- TAG fixture (mirrors tests/unit/models/exportSession.integration.test.ts's own fixture) ---
const TAG_LEAVES = [{keyPath: "credentialSubject.name", saltHex: `0x${"aa".repeat(16)}`, tag: TypeTag.String, value: "Rex"}];
const TAG_RESERVED_LEAF_HASHES = [
  toHex32(hashLeaf("owner.address", new Uint8Array(16).fill(1), {tag: TypeTag.Bytes, value: new Uint8Array([1])} as TypedScalar)),
  toHex32(hashLeaf("owner.consentKey", new Uint8Array(16).fill(2), {tag: TypeTag.Bytes, value: new Uint8Array([2])} as TypedScalar)),
  toHex32(hashLeaf("owner.secret", new Uint8Array(16).fill(3), {tag: TypeTag.Bytes, value: new Uint8Array([3])} as TypedScalar)),
];
const TAG_ROOT = toHex32(
  buildMerkle([
    ...TAG_RESERVED_LEAF_HASHES.map((h) => BigInt(h)),
    ...TAG_LEAVES.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), {tag: l.tag, value: l.value} as TypedScalar)),
  ]).root,
);

async function seedTagPetAndArtifact(petId: string): Promise<void> {
  await Pet.create({
    petId,
    name: "Rex",
    ownerClientIds: [],
    dogTag: {dogTagIdDec: "42", dogTagIdField: "999999", root: TAG_ROOT, status: "active", cloneAddress: CLONE},
    searchKey: "rex",
  });
  await TagArtifact.create({
    petId,
    dogTagIdDec: "42",
    dogTagIdField: "999999",
    root: TAG_ROOT,
    protocolVersion: "dogtag-v2/1",
    leaves: TAG_LEAVES,
    reservedLeafHashes: TAG_RESERVED_LEAF_HASHES,
    source: "issued_here",
    issuerClone: CLONE,
    verifiedAt: 1_700_000_000,
    active: true,
  });
}

describe("GET /e/:token dispatch - the tag path stays byte-identical", () => {
  it("a plain tag session (artifactType absent, exactly like every pre-WP4.14 session) resolves through the SAME route handler unchanged", async () => {
    await seedTagPetAndArtifact("pet-tag-e2e");
    await ClinicSettings.create({_id: "singleton", businessProfile: {name: "Example Vet Clinic"}});
    const token = "e".repeat(32);
    await ArtifactExportSession.create({token, petId: "pet-tag-e2e", root: TAG_ROOT, exp: Math.floor(Date.now() / 1000) + 600});

    const res = await exportTokenGET(new Request(`https://vet.example.com/e/${token}`), tokenParams(token));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Byte-identical to the pre-WP4.14 tag shape: no artifactType field on a legacy-style session,
    // the deprecated `leaves` alias present and IDENTICAL to `disclosed` (WP4.9M's shipped
    // ArtifactReceiveEngine decodes `leaves` as non-optional - see exportFlow.ts's own header).
    expect(body.artifactType).toBeUndefined();
    expect(body.leaves).toEqual(body.disclosed);
    expect(body.leaves).toEqual(TAG_LEAVES);
    expect(body.root).toBe(TAG_ROOT);
    expect(body.issuerClone).toBe(CLONE);
    expect(body.dogTagIdField).toBe("999999");
    expect(body.reservedLeafHashes).toEqual(TAG_RESERVED_LEAF_HASHES);
    expect(body.petName).toBe("Rex");
    expect(body.clinicName).toBe("Example Vet Clinic");
    expect(typeof body.chainId).toBe("number");

    // One-shot: burned exactly like before.
    const resAgain = await exportTokenGET(new Request(`https://vet.example.com/e/${token}`), tokenParams(token));
    expect(resAgain.status).toBe(410);
  });
});

describe("record export (plan section 11.2 V5)", () => {
  async function seedActiveRecord(petId: string, recordId?: string): Promise<RecordArtifactDoc> {
    await Pet.create({
      petId,
      name: "Blaze",
      ownerClientIds: [],
      dogTag: {dogTagIdDec: "424242", dogTagIdField: "424242", root: `0x${"a".repeat(64)}`, status: "active", cloneAddress: CLONE},
      searchKey: "blaze",
    });
    const {leaves, root} = buildVaccinationRecord(
      {
        targetDisease: "rabies",
        vaccineProductName: "Rabvac 3",
        vaccineManufacturer: "Boehringer Ingelheim",
        batchLotNumber: "LOT-998",
        vaccinationDate: "2026-09-01",
        validFrom: "2026-09-01",
        validUntil: "2027-09-01",
      },
      {dogTagIdField: "424242", issuer: {chainId: 1337, contract: CLONE, operator: OPERATOR}},
    );
    const created = await RecordArtifact.create({
      recordId: recordId ?? randomUUID(),
      petId,
      dogTagIdField: "424242",
      recordType: "VACCINATION",
      schemaId: VACCINATION_SCHEMA_ID,
      schemaVersion: VACCINATION_SCHEMA_VERSION,
      protocolVersion: "dogtag-v2/1",
      root,
      leaves,
      nonMaskable: [
        "credentialSubject.dogTagId",
        "recordType",
        "credentialSchema.id",
        "credentialSchema.version",
        "issuer.chainId",
        "issuer.contract",
        "issuer.operator",
      ],
      status: "active",
      chain: {chainId: 1337, contract: CLONE, operator: OPERATOR, txHash: `0x${"7".repeat(64)}`, blockNumber: 12345},
      conformsTo: [{standard: "nasphv-form51", version: "2007"}],
    });
    return created.toObject();
  }

  it("creates an export session and GET /e/:token returns a RecordArtifact-shaped response", async () => {
    await withStaffSession();
    const record = await seedActiveRecord("pet-record-e2e");
    await ClinicSettings.create({_id: "singleton", businessProfile: {name: "Riverside Vet Clinic"}});

    const createRes = await recordExportPOST(
      new Request(`https://vet.example.com/api/pets/pet-record-e2e/records/${record.recordId}/export`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({}),
      }),
      {params: Promise.resolve({id: "pet-record-e2e", recordId: record.recordId})},
    );
    expect(createRes.status).toBe(201);
    const {token} = (await createRes.json()) as {token: string};

    const res = await exportTokenGET(new Request(`https://vet.example.com/e/${token}`), tokenParams(token));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.artifactType).toBe("record");
    expect(body.recordType).toBe("VACCINATION");
    expect(body.root).toBe(record.root);
    expect(body.reservedLeafHashes).toEqual([]);
    expect(body.obfuscatedLeafHashes).toEqual([]);
    expect(body.disclosed.length).toBe(record.leaves.length);
    expect(body.conformsTo).toEqual([{standard: "nasphv-form51", version: "2007"}]);
    expect(body.anchoring).toMatchObject({chainId: 1337, contract: CLONE, blockNumber: 12345});
    expect(body.petName).toBe("Blaze");
    expect(body.clinicName).toBe("Riverside Vet Clinic");

    // NEVER present on a record response (specs/vet-public-api.yaml's own ArtifactExportResponse).
    expect(body.dogTagIdField).toBeUndefined();
    expect(body.dogTagIdDec).toBeUndefined();
    expect(body.leaves).toBeUndefined();
    expect(body.issuerClone).toBeUndefined();

    // One-shot: burned exactly like the tag ceremony.
    const resAgain = await exportTokenGET(new Request(`https://vet.example.com/e/${token}`), tokenParams(token));
    expect(resAgain.status).toBe(410);
  });

  it("refuses to create an export session naming a non-maskable keyPath in mask (locked in the UI AND enforced server-side)", async () => {
    await withStaffSession();
    const record = await seedActiveRecord("pet-record-locked");

    const res = await recordExportPOST(
      new Request(`https://vet.example.com/api/pets/pet-record-locked/records/${record.recordId}/export`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({mask: ["issuer.operator"]}),
      }),
      {params: Promise.resolve({id: "pet-record-locked", recordId: record.recordId})},
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.details.fieldErrors.mask).toEqual([{keyPath: "issuer.operator", reason: "non_maskable"}]);
  });

  it("a maskable field (not one of the seven) can be masked - the export omits its opening and carries only its hash", async () => {
    await withStaffSession();
    const record = await seedActiveRecord("pet-record-masked");
    await ClinicSettings.create({_id: "singleton", businessProfile: {name: "Riverside Vet Clinic"}});

    const createRes = await recordExportPOST(
      new Request(`https://vet.example.com/api/pets/pet-record-masked/records/${record.recordId}/export`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({mask: ["batchLotNumber"]}),
      }),
      {params: Promise.resolve({id: "pet-record-masked", recordId: record.recordId})},
    );
    expect(createRes.status).toBe(201);
    const {token} = (await createRes.json()) as {token: string};

    const res = await exportTokenGET(new Request(`https://vet.example.com/e/${token}`), tokenParams(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disclosed.find((l: {keyPath: string}) => l.keyPath === "batchLotNumber")).toBeUndefined();
    expect(body.obfuscatedLeafHashes.length).toBe(1);
  });

  it("revoked: a record revoked after the session was created refuses at GET /e/:token, code 'revoked'", async () => {
    await withStaffSession();
    const record = await seedActiveRecord("pet-record-revoked");

    const createRes = await recordExportPOST(
      new Request(`https://vet.example.com/api/pets/pet-record-revoked/records/${record.recordId}/export`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({}),
      }),
      {params: Promise.resolve({id: "pet-record-revoked", recordId: record.recordId})},
    );
    const {token} = (await createRes.json()) as {token: string};
    await RecordArtifact.updateOne({recordId: record.recordId}, {$set: {status: "revoked"}});

    const res = await exportTokenGET(new Request(`https://vet.example.com/e/${token}`), tokenParams(token));
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error.code).toBe("revoked");
  });

  it("a REAL concurrent race: exactly one of two simultaneous resolves gets the payload (mongoRecordExportStore.tryConsume's atomic findOneAndUpdate)", async () => {
    const record = await seedActiveRecord("pet-record-race");
    const now = Math.floor(Date.now() / 1000);
    const session = await ArtifactExportSession.create({
      token: "f".repeat(32),
      petId: "pet-record-race",
      artifactType: "record",
      recordId: record.recordId,
      root: record.root,
      exp: now + 600,
    });

    const [first, second] = await Promise.all([
      resolveAndConsumeRecordExport(mongoRecordExportStore, session.token, now),
      resolveAndConsumeRecordExport(mongoRecordExportStore, session.token, now),
    ]);
    const outcomes = [first, second];
    const winners = outcomes.filter((r) => r.ok);
    const losers = outcomes.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toEqual({ok: false, code: "expired_or_reused"});
  });

  it("refuses to create an export session for a non-active record (draft/issuing/error)", async () => {
    await withStaffSession();
    const record = await seedActiveRecord("pet-record-draft");
    await RecordArtifact.updateOne({recordId: record.recordId}, {$set: {status: "draft"}});

    const res = await recordExportPOST(
      new Request(`https://vet.example.com/api/pets/pet-record-draft/records/${record.recordId}/export`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({}),
      }),
      {params: Promise.resolve({id: "pet-record-draft", recordId: record.recordId})},
    );
    expect(res.status).toBe(400);
  });
});
