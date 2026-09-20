import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {recordTypeKey} from "@dogtag/standard";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";
import {buildVaccinationRecord, recomputeRecordLeafHash} from "@/lib/records/build";
import {roax} from "@/lib/chains";

/**
 * `POST /api/verify/records/start` -> `GET /v/:token` -> `POST /v/:token/complete` -> `GET
 * /api/verify/records/:sessionId` end to end (plan section 11.2 V6). ISOLATION: own ephemeral
 * mongod, port 44140 (44117-44139 already taken by sibling suites).
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));
vi.mock("@/lib/chainRead", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chainRead")>();
  return {...actual, readRootIssuer: vi.fn(), readRecordTypeOf: vi.fn(), readIsValidRoot: vi.fn(), readIssuedBy: vi.fn()};
});

import {auth} from "@/auth";
import * as chainRead from "@/lib/chainRead";
import {connectToDatabase} from "@/lib/db";
import {Staff} from "@/lib/models/Staff";
import {RecordVerifySession} from "@/lib/models/RecordVerifySession";
import {POST as startPOST} from "@/app/api/verify/records/start/route";
import {GET as resolveGET} from "@/app/v/[token]/route";
import {POST as completePOST} from "@/app/v/[token]/complete/route";
import {GET as pollGET} from "@/app/api/verify/records/[sessionId]/route";

const MONGO_PORT = 44_140;
process.env.VET_ISSUER_FACTORY_ADDRESS = "0x0000000000000000000000000000000000fac10e";
const CLONE = "0x0000000000000000000000000000000000c10be5";
const OPERATOR = "0x0000000000000000000000000000000000000ff1";

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-record-verify");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  await RecordVerifySession.init();
}, 90_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Promise.all([Staff.deleteMany({}), RecordVerifySession.deleteMany({})]);
  vi.mocked(auth).mockReset();
  vi.mocked(chainRead.readRootIssuer).mockReset();
  vi.mocked(chainRead.readRecordTypeOf).mockReset();
  vi.mocked(chainRead.readIsValidRoot).mockReset();
  vi.mocked(chainRead.readIssuedBy).mockReset();
});

async function withStaffSession(): Promise<void> {
  const staff = await Staff.create({email: `staff-${randomUUID()}@example.com`, role: "staff", firstName: "Jane", lastName: "Tan"});
  vi.mocked(auth).mockResolvedValue({user: {staffId: staff.staffId}} as never);
}

function tokenParams(token: string): {params: Promise<{token: string}>} {
  return {params: Promise.resolve({token})};
}
function sessionParams(sessionId: string): {params: Promise<{sessionId: string}>} {
  return {params: Promise.resolve({sessionId})};
}

function buildPresentableArtifact(validUntil = "2099-01-01") {
  const {leaves, root} = buildVaccinationRecord(
    {
      targetDisease: "rabies",
      vaccineProductName: "Rabvac 3",
      vaccineManufacturer: "Boehringer Ingelheim",
      batchLotNumber: "LOT-998",
      vaccinationDate: "2026-09-01",
      validFrom: "2026-09-01",
      validUntil,
    },
    {dogTagIdField: "424242", issuer: {chainId: roax.id, contract: CLONE, operator: OPERATOR}},
  );
  return {protocolVersion: "dogtag-v2/1", artifactType: "record", root, disclosed: leaves, obfuscatedLeafHashes: [], reservedLeafHashes: []};
}

describe("records verify mode (plan section 11.2 V6)", () => {
  it("a plain staff member can start a session (no vet/owner gate needed)", async () => {
    await withStaffSession();
    const res = await startPOST(new Request("https://vet.example.com/api/verify/records/start", {method: "POST"}));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.qr).toContain("/v/");
    expect(typeof body.sessionId).toBe("string");
  });

  it("unauthenticated cannot start a session", async () => {
    const res = await startPOST(new Request("https://vet.example.com/api/verify/records/start", {method: "POST"}));
    expect(res.status).toBe(401);
  });

  it("full happy path: start -> resolve -> complete -> staff poll shows Valid", async () => {
    await withStaffSession();
    const startRes = await startPOST(new Request("https://vet.example.com/api/verify/records/start", {method: "POST"}));
    const {sessionId, token} = (await startRes.json()) as {sessionId: string; token: string};

    const resolveRes = await resolveGET(new Request(`https://vet.example.com/v/${token}`), tokenParams(token));
    expect(resolveRes.status).toBe(200);
    const resolveBody = await resolveRes.json();
    expect(resolveBody.status).toBe("pending");

    vi.mocked(chainRead.readRootIssuer).mockResolvedValue(CLONE);
    vi.mocked(chainRead.readRecordTypeOf).mockResolvedValue(recordTypeKey("VACCINATION"));
    vi.mocked(chainRead.readIsValidRoot).mockResolvedValue(true);
    vi.mocked(chainRead.readIssuedBy).mockResolvedValue(OPERATOR);

    const completeRes = await completePOST(
      new Request(`https://vet.example.com/v/${token}/complete`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({artifact: buildPresentableArtifact()}),
      }),
      tokenParams(token),
    );
    expect(completeRes.status).toBe(200);
    const completeBody = await completeRes.json();
    expect(completeBody.result.stage).toBe("verified");
    expect(completeBody.result.validity).toBe("valid");

    const pollRes = await pollGET(new Request(`https://vet.example.com/api/verify/records/${sessionId}`), sessionParams(sessionId));
    expect(pollRes.status).toBe(200);
    const pollBody = await pollRes.json();
    expect(pollBody.status).toBe("presented");
    expect(pollBody.result.stage).toBe("verified");
    expect(pollBody.result.validity).toBe("valid");
    expect(pollBody.result.disclosedKeyPaths).toContain("targetDisease");

    // One-shot: a repeat complete is refused.
    const completeAgain = await completePOST(
      new Request(`https://vet.example.com/v/${token}/complete`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({artifact: buildPresentableArtifact()}),
      }),
      tokenParams(token),
    );
    expect(completeAgain.status).toBe(410);
  });

  it("expired: a revoked record shows the Revoked stage, not a bare failure", async () => {
    await withStaffSession();
    const startRes = await startPOST(new Request("https://vet.example.com/api/verify/records/start", {method: "POST"}));
    const {token} = (await startRes.json()) as {token: string};

    vi.mocked(chainRead.readRootIssuer).mockResolvedValue(CLONE);
    vi.mocked(chainRead.readRecordTypeOf).mockResolvedValue(recordTypeKey("VACCINATION"));
    vi.mocked(chainRead.readIsValidRoot).mockResolvedValue(false);
    vi.mocked(chainRead.readIssuedBy).mockResolvedValue(OPERATOR);

    const completeRes = await completePOST(
      new Request(`https://vet.example.com/v/${token}/complete`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({artifact: buildPresentableArtifact()}),
      }),
      tokenParams(token),
    );
    const body = await completeRes.json();
    expect(body.result).toEqual({
      stage: "verified",
      issuerClone: CLONE,
      recordType: "VACCINATION",
      validity: "revoked",
      disclosedKeyPaths: expect.any(Array),
      hiddenCount: 0,
    });
  });

  it("hiddenCount reflects a genuinely masked presentment - plan section 11.2 V6's own explicit ask ('disclosed fields, hidden count')", async () => {
    await withStaffSession();
    const startRes = await startPOST(new Request("https://vet.example.com/api/verify/records/start", {method: "POST"}));
    const {token} = (await startRes.json()) as {token: string};

    vi.mocked(chainRead.readRootIssuer).mockResolvedValue(CLONE);
    vi.mocked(chainRead.readRecordTypeOf).mockResolvedValue(recordTypeKey("VACCINATION"));
    vi.mocked(chainRead.readIsValidRoot).mockResolvedValue(true);
    vi.mocked(chainRead.readIssuedBy).mockResolvedValue(OPERATOR);

    // Same fixture as buildPresentableArtifact, but MASK two genuinely-maskable leaves
    // (vaccineManufacturer, batchLotNumber - neither is one of the seven non-maskable keyPaths) by
    // moving their openings out of `disclosed` and into `obfuscatedLeafHashes` - `root` is unchanged
    // since masking never touches the tree, only which openings are handed over.
    const full = buildPresentableArtifact();
    const maskedKeyPaths = new Set(["vaccineManufacturer", "batchLotNumber"]);
    const disclosed = full.disclosed.filter((l) => !maskedKeyPaths.has(l.keyPath));
    const obfuscatedLeafHashes = full.disclosed.filter((l) => maskedKeyPaths.has(l.keyPath)).map((l) => recomputeRecordLeafHash(l));
    const maskedArtifact = {...full, disclosed, obfuscatedLeafHashes};

    const completeRes = await completePOST(
      new Request(`https://vet.example.com/v/${token}/complete`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({artifact: maskedArtifact}),
      }),
      tokenParams(token),
    );
    expect(completeRes.status).toBe(200);
    const body = await completeRes.json();
    expect(body.result.stage).toBe("verified");
    expect(body.result.hiddenCount).toBe(2);
    expect(body.result.disclosedKeyPaths).not.toContain("vaccineManufacturer");
    expect(body.result.disclosedKeyPaths).not.toContain("batchLotNumber");
  });

  it("a malformed artifact body is refused (400) before any chain read", async () => {
    await withStaffSession();
    const startRes = await startPOST(new Request("https://vet.example.com/api/verify/records/start", {method: "POST"}));
    const {token} = (await startRes.json()) as {token: string};

    const res = await completePOST(
      new Request(`https://vet.example.com/v/${token}/complete`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({artifact: {not: "a record artifact"}}),
      }),
      tokenParams(token),
    );
    expect(res.status).toBe(400);

    // The token is NOT burned by a malformed body - still resolvable/pending.
    const resolveRes = await resolveGET(new Request(`https://vet.example.com/v/${token}`), tokenParams(token));
    expect((await resolveRes.json()).status).toBe("pending");
  });

  it("404s for an unknown token on both resolve and complete", async () => {
    const unknown = "a".repeat(32);
    const resolveRes = await resolveGET(new Request(`https://vet.example.com/v/${unknown}`), tokenParams(unknown));
    expect(resolveRes.status).toBe(404);
    const completeRes = await completePOST(
      new Request(`https://vet.example.com/v/${unknown}/complete`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({artifact: buildPresentableArtifact()}),
      }),
      tokenParams(unknown),
    );
    expect(completeRes.status).toBe(404);
  });
});
