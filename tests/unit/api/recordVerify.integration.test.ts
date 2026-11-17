import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {recordTypeKey} from "@dogtag/standard";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";
import {buildVaccinationRecord, recomputeRecordLeafHash} from "@/lib/records/build";
import {roax} from "@/lib/chains";

/**
 * `POST /api/verify/records/start` -> `GET /v/:token` -> `POST /v/:token/complete` -> `GET
 * /api/verify/records/:sessionId` end to end (plan section 11.2 V6). ISOLATION: own ephemeral mongod on a freshly OS-reserved free port (see
 * tests/unit/helpers/ephemeralMongod.ts - each spawn reserves a currently-free port by binding
 * and releasing a throwaway socket, unique across concurrent processes including two whole
 * copies of this suite running at once, and retries on a genuine bind collision, so no fixed
 * port or manual coordination between sibling suites is needed).
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));
vi.mock("@/lib/chainRead", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chainRead")>();
  return {...actual, readRootIssuer: vi.fn(), readRecordTypeOf: vi.fn(), readIsValidRoot: vi.fn(), readIssuedBy: vi.fn(), readCloneOwner: vi.fn(), readEntityKindsIfConfigured: vi.fn()};
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

process.env.VET_ISSUER_FACTORY_ADDRESS = "0x0000000000000000000000000000000000fac10e";
process.env.ENTITY_REGISTRY_ADDRESS = "0x00000000000000000000000000000000000e9157";
const OWNER = "0x00000000000000000000000000000000000000a1";
const CLONE = "0x0000000000000000000000000000000000c10be5";
const OPERATOR = "0x0000000000000000000000000000000000000ff1";

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod("dogtag-vet-record-verify");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.port).toBe(ephemeral.port);
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
  vi.mocked(chainRead.readCloneOwner).mockReset();
  vi.mocked(chainRead.readEntityKindsIfConfigured).mockReset();
});

/** The WP4.21 issuer reads: the clone owner, and what the registry says about them. */
function mockIssuer(kinds: Awaited<ReturnType<typeof chainRead.readEntityKindsIfConfigured>> = {status: "registered", mask: 2n}): void {
  vi.mocked(chainRead.readCloneOwner).mockResolvedValue(OWNER);
  vi.mocked(chainRead.readEntityKindsIfConfigured).mockResolvedValue(kinds);
}

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
    mockIssuer();

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
    expect(pollBody.result.issuer).toEqual({account: OWNER, kinds: ["VET"], registered: true});

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
    mockIssuer();

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
      issuer: {account: OWNER, kinds: ["VET"], registered: true},
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
    mockIssuer();

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

  describe("issuer block (WP4.21) through the route and the session store", () => {
    async function presentAndPoll(): Promise<{complete: {result: Record<string, unknown>}; poll: {result: Record<string, unknown>}}> {
      await withStaffSession();
      const startRes = await startPOST(new Request("https://vet.example.com/api/verify/records/start", {method: "POST"}));
      const {sessionId, token} = (await startRes.json()) as {sessionId: string; token: string};
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
      const complete = await completeRes.json();
      const pollRes = await pollGET(new Request(`https://vet.example.com/api/verify/records/${sessionId}`), sessionParams(sessionId));
      return {complete, poll: await pollRes.json()};
    }

    it("a government owner persists and is served as kinds [GOVERNMENT]; the result is still Valid", async () => {
      vi.mocked(chainRead.readCloneOwner).mockResolvedValue(OWNER);
      vi.mocked(chainRead.readEntityKindsIfConfigured).mockResolvedValue({status: "registered", mask: 4n});
      const {complete, poll} = await presentAndPoll();
      expect(complete.result).toMatchObject({stage: "verified", validity: "valid", issuer: {account: OWNER, kinds: ["GOVERNMENT"], registered: true}});
      expect(poll.result.issuer).toEqual({account: OWNER, kinds: ["GOVERNMENT"], registered: true});
    });

    it("an unregistered owner persists as kinds [] (not null)", async () => {
      vi.mocked(chainRead.readCloneOwner).mockResolvedValue(OWNER);
      vi.mocked(chainRead.readEntityKindsIfConfigured).mockResolvedValue({status: "not_registered"});
      const {poll} = await presentAndPoll();
      expect(poll.result.issuer).toEqual({account: OWNER, kinds: [], registered: false});
    });

    it("an unreadable registry persists as kinds null (never []), and the record is still Valid", async () => {
      vi.mocked(chainRead.readCloneOwner).mockResolvedValue(OWNER);
      vi.mocked(chainRead.readEntityKindsIfConfigured).mockResolvedValue({status: "unreadable"});
      const {complete, poll} = await presentAndPoll();
      expect(complete.result).toMatchObject({stage: "verified", validity: "valid", issuer: {account: OWNER, kinds: null, registered: false}});
      expect(poll.result.issuer).toEqual({account: OWNER, kinds: null, registered: false});
      expect(poll.result.validity).toBe("valid");
    });

    it("an unreadable clone owner omits the issuer block and leaves the result Valid", async () => {
      vi.mocked(chainRead.readCloneOwner).mockRejectedValue(new Error("RPC timeout"));
      const {complete, poll} = await presentAndPoll();
      expect(complete.result).toMatchObject({stage: "verified", validity: "valid"});
      expect(complete.result).not.toHaveProperty("issuer");
      expect(poll.result).not.toHaveProperty("issuer");
    });

    it("a session stored before WP4.21 (no issuer field) still polls fine", async () => {
      await withStaffSession();
      const created = await RecordVerifySession.create({
        token: "b".repeat(32),
        exp: Math.floor(Date.now() / 1000) + 600,
        status: "presented",
        result: {stage: "verified", issuerClone: CLONE, recordType: "VACCINATION", validity: "valid", disclosedKeyPaths: [], hiddenCount: 0},
      });
      const res = await pollGET(new Request("https://vet.example.com/x"), sessionParams(created.sessionId));
      const body = await res.json();
      expect(body.result.stage).toBe("verified");
      expect(body.result).not.toHaveProperty("issuer");
    });
  });
});
