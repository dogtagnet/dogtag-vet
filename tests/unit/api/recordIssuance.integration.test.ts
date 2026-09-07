import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {privateKeyToAccount} from "viem/accounts";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * Plan section 11.2 item V3 - the vaccination-record issuance flow: create (draft) -> tx (issuing)
 * -> confirm (active, fail-closed on all 4 chain reads) -> attestation (C3, EIP-712). Modelled on
 * `tests/unit/api/issuanceRouteGuards.integration.test.ts` (auth mocking) and `tests/unit/api/
 * importComplete.integration.test.ts` (chainRead mocking) - the same two conventions every route
 * integration test in this repo already uses.
 *
 * ISOLATION: own ephemeral mongod, port 44137 (44117-44136 already taken by sibling suites).
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));
vi.mock("@/lib/chainRead", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chainRead")>();
  return {
    ...actual,
    readEntityActive: vi.fn(),
    readOperatorWhitelisted: vi.fn(),
    readRootIssuer: vi.fn(),
    readIsValidRoot: vi.fn(),
    readRecordTypeOf: vi.fn(),
    readIssuedBy: vi.fn(),
    readTxReceiptStatus: vi.fn(),
    readTxAnchoring: vi.fn(),
    readRecordTypeVaccination: vi.fn(),
  };
});
// `getServerEnv()` caches its parsed snapshot for the lifetime of the process (env.ts's own doc
// comment: "safe to call anywhere ... never throws"), so a plain `delete process.env.X` between
// tests in this same file has no effect once anything has already called it - every OTHER test
// above already has, by the time this file's last describe block runs. `requireEnv` alone is
// wrapped (default implementation delegates to the real one) so exactly one test below can make
// exactly one call throw, without disturbing the real cached env for every other test.
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {...actual, requireEnv: vi.fn(actual.requireEnv)};
});

import {auth} from "@/auth";
import * as chainRead from "@/lib/chainRead";
import * as envModule from "@/lib/env";
import {connectToDatabase} from "@/lib/db";
import {Staff} from "@/lib/models/Staff";
import {ClinicSettings} from "@/lib/models/ClinicSettings";
import {Pet} from "@/lib/models/Pet";
import {RecordArtifact, type RecordArtifactDoc} from "@/lib/models/RecordArtifact";
import {GET as listGET, POST as createPOST} from "@/app/api/pets/[id]/records/route";
import {GET as recordGET} from "@/app/api/records/[id]/route";
import {POST as txPOST} from "@/app/api/records/[id]/tx/route";
import {POST as confirmPOST} from "@/app/api/records/[id]/confirm/route";
import {GET as attestationGET, POST as attestationPOST} from "@/app/api/records/[id]/attestation/route";

const MONGO_PORT = 44_137;

// Every address below is a plain 0x + 40 hex chars (`hexAddress`'s own schema requirement) -
// lengths double-checked with `node -e` before use, not eyeballed (a too-short hex string is an
// easy transcription mistake, and zod's regex catches it as a 400 that looks like an unrelated
// route failure if you don't check the response body first).
const OUR_CLONE = "0x86d9ac6c094783e6a27d3bdbb6ef868060256c75";
const OPERATOR = "0x1500000000000000000000000000000000005cda";
const OTHER_OPERATOR = "0x0000000000000000000000000000000000000bad";
const FACTORY = "0x0000000000000000000000000000000000faceac";
const ENTITY_REGISTRY = "0x000000000000000000000000000000000000ee00";
const SBT = "0x000000000000000000000000000000000000cbcd";
// keccak256("VACCINATION") - independently confirmed against both viem's own keccak256 and
// @dogtag/standard's recordTypeKey (see tests/unit/records/build.test.ts's sibling checks; this
// route never re-derives it, it only ever compares against what the chain reports).
const VACCINATION_RECORD_TYPE_HASH = "0x6510790a1a3e04db26bd73ea6246e7e8defb25eb4281f709e29decd6b8ca0561";
const ZERO_HEX32 = `0x${"0".repeat(64)}`;

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-record-issuance");
  process.env.MONGODB_URI = ephemeral.uri;
  process.env.ENTITY_REGISTRY_ADDRESS = ENTITY_REGISTRY;
  process.env.DOGTAG_SBT_ADDRESS = SBT;
  process.env.VET_ISSUER_FACTORY_ADDRESS = FACTORY;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  await RecordArtifact.init();
}, 30_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Promise.all([Staff.deleteMany({}), ClinicSettings.deleteMany({}), Pet.deleteMany({}), RecordArtifact.deleteMany({})]);
  vi.mocked(auth).mockReset();
  vi.mocked(chainRead.readEntityActive).mockReset();
  vi.mocked(chainRead.readOperatorWhitelisted).mockReset();
  vi.mocked(chainRead.readRootIssuer).mockReset();
  vi.mocked(chainRead.readIsValidRoot).mockReset();
  vi.mocked(chainRead.readRecordTypeOf).mockReset();
  vi.mocked(chainRead.readIssuedBy).mockReset();
  vi.mocked(chainRead.readTxReceiptStatus).mockReset();
  vi.mocked(chainRead.readTxAnchoring).mockReset();
  vi.mocked(chainRead.readRecordTypeVaccination).mockReset();
});

async function withStaffSession(role: "vet" | "owner" | "staff"): Promise<void> {
  const staff = await Staff.create({
    email: `${role}-${randomUUID()}@example.com`,
    role,
    firstName: "Jane",
    lastName: "Tan",
    title: "DVM",
    accreditationNumber: "USDA-12345",
  });
  vi.mocked(auth).mockResolvedValue({user: {staffId: staff.staffId, email: staff.email}} as never);
}

async function seedClinicAndPet(petId: string): Promise<void> {
  await ClinicSettings.create({
    _id: "singleton",
    cloneAddress: OUR_CLONE,
    entityAccount: "0x0000000000000000000000000000000000ea7171",
    businessProfile: {name: "Riverside Vet Clinic", domain: "riverside.example"},
  });
  await Pet.create({
    petId,
    name: "Blaze",
    ownerClientIds: [],
    dogTag: {dogTagIdDec: "424242", dogTagIdField: "424242", root: `0x${"a".repeat(64)}`, status: "active", cloneAddress: OUR_CLONE},
    searchKey: "blaze",
  });
  vi.mocked(chainRead.readEntityActive).mockResolvedValue(true);
  vi.mocked(chainRead.readOperatorWhitelisted).mockResolvedValue(true);
}

const VALID_FORM = {
  targetDisease: "rabies",
  vaccineProductName: "Rabvac 3",
  vaccineManufacturer: "Boehringer Ingelheim",
  batchLotNumber: "LOT-998",
  vaccinationDate: "2026-09-01",
  validFrom: "2026-09-01",
  validUntil: "2027-09-01",
};

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
}

function idParams(id: string): {params: Promise<{id: string}>} {
  return {params: Promise.resolve({id})};
}

describe("auth gating", () => {
  it("POST /api/pets/:id/records - a plain staff member (not vet/owner) gets 403", async () => {
    const petId = randomUUID();
    await withStaffSession("staff");
    const res = await createPOST(
      jsonRequest(`https://vet.example.com/api/pets/${petId}/records`, {operatorAddress: OPERATOR, form: VALID_FORM}),
      idParams(petId),
    );
    expect(res.status).toBe(403);
  });

  it("GET /api/pets/:id/records - a plain staff member CAN list (staff-gated, not vet-gated)", async () => {
    const petId = randomUUID();
    await withStaffSession("staff");
    const res = await listGET(new Request(`https://vet.example.com/api/pets/${petId}/records`), idParams(petId));
    expect(res.status).not.toBe(403);
  });
});

describe("conformsTo (UNCOMMITTED, descriptive-only vet claim - lib/records/standards.ts)", () => {
  it("accepts a known (standard, version) pair and stores it on the draft", async () => {
    const petId = randomUUID();
    await withStaffSession("vet");
    await seedClinicAndPet(petId);

    const res = await createPOST(
      jsonRequest(`https://vet.example.com/api/pets/${petId}/records`, {
        operatorAddress: OPERATOR,
        form: VALID_FORM,
        conformsTo: [{standard: "nasphv-form51", version: "2007"}],
      }),
      idParams(petId),
    );
    expect(res.status).toBe(201);
    const {record} = (await res.json()) as {record: RecordArtifactDoc};
    expect(record.conformsTo).toEqual([{standard: "nasphv-form51", version: "2007"}]);
  });

  it("rejects a standard/version pair this protocol version does not recognize", async () => {
    const petId = randomUUID();
    await withStaffSession("vet");
    await seedClinicAndPet(petId);

    const res = await createPOST(
      jsonRequest(`https://vet.example.com/api/pets/${petId}/records`, {
        operatorAddress: OPERATOR,
        form: VALID_FORM,
        conformsTo: [{standard: "nasphv-form51", version: "1999"}],
      }),
      idParams(petId),
    );
    expect(res.status).toBe(400);
  });

  it("omitting conformsTo entirely defaults to an empty array (no claimed conformance)", async () => {
    const petId = randomUUID();
    await withStaffSession("vet");
    await seedClinicAndPet(petId);

    const res = await createPOST(
      jsonRequest(`https://vet.example.com/api/pets/${petId}/records`, {operatorAddress: OPERATOR, form: VALID_FORM}),
      idParams(petId),
    );
    expect(res.status).toBe(201);
    const {record} = (await res.json()) as {record: RecordArtifactDoc};
    expect(record.conformsTo).toEqual([]);
  });
});

describe("issuance happy path: create -> tx -> confirm -> attestation", () => {
  it("walks a vaccination record from draft through active with a signed C3 attestation", async () => {
    const petId = randomUUID();
    await withStaffSession("vet");
    await seedClinicAndPet(petId);

    // 1. CREATE (draft) - server builds leaves + root, no owner-device round trip.
    const createRes = await createPOST(
      jsonRequest(`https://vet.example.com/api/pets/${petId}/records`, {operatorAddress: OPERATOR, form: VALID_FORM}),
      idParams(petId),
    );
    expect(createRes.status).toBe(201);
    const {record: created} = (await createRes.json()) as {record: RecordArtifactDoc};
    expect(created.status).toBe("draft");
    expect(created.root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(created.chain.operator).toBe(OPERATOR);
    expect(created.chain.contract).toBe(OUR_CLONE);
    expect(created.leaves.map((l) => l.keyPath)).toEqual(
      expect.arrayContaining([
        "credentialSubject.dogTagId",
        "recordType",
        "credentialSchema.id",
        "credentialSchema.version",
        "issuer.chainId",
        "issuer.contract",
        "issuer.operator",
        "authorizedVet",
      ]),
    );
    const authorizedVetLeaf = created.leaves.find((l) => l.keyPath === "authorizedVet");
    expect(authorizedVetLeaf?.value).toBe("Jane Tan, DVM (USDA-12345)");

    // GET single (poll) reflects the draft.
    const pollDraft = await recordGET(new Request(`https://vet.example.com/api/records/${created.recordId}`), idParams(created.recordId));
    expect((await pollDraft.json()).record.status).toBe("draft");

    // 2. TX - the staff wallet's issueRecord transaction hash is recorded.
    const txHash = `0x${"1".repeat(64)}`;
    const txRes = await txPOST(
      jsonRequest(`https://vet.example.com/api/records/${created.recordId}/tx`, {txHash, operatorAddress: OPERATOR}),
      idParams(created.recordId),
    );
    expect(txRes.status).toBe(200);
    expect((await txRes.json()).status).toBe("issuing");

    // 3. CONFIRM - all 4 chain reads must agree.
    vi.mocked(chainRead.readTxReceiptStatus).mockResolvedValue("success");
    vi.mocked(chainRead.readRootIssuer).mockResolvedValue(OUR_CLONE);
    vi.mocked(chainRead.readIsValidRoot).mockResolvedValue(true);
    vi.mocked(chainRead.readRecordTypeOf).mockResolvedValue(VACCINATION_RECORD_TYPE_HASH);
    vi.mocked(chainRead.readIssuedBy).mockResolvedValue(OPERATOR);
    const anchoredBlockTime = new Date("2026-01-15T10:00:00.000Z");
    vi.mocked(chainRead.readTxAnchoring).mockResolvedValue({blockNumber: 12345, blockTime: anchoredBlockTime});

    const confirmRes = await confirmPOST(new Request(`https://vet.example.com/api/records/${created.recordId}/confirm`, {method: "POST"}), idParams(created.recordId));
    expect(confirmRes.status).toBe(200);
    const confirmed = (await confirmRes.json()) as {status: string; contract: string};
    expect(confirmed.status).toBe("active");
    expect(confirmed.contract).toBe(OUR_CLONE);

    // The anchoring block number/timestamp (advisor review finding: previously never populated -
    // `reconcileAnchoredRecord` only ever passed `{contract}` to `markRecordActive`) land on the
    // record via a real GET poll, not just the confirm response's own smaller body.
    const pollActive = await recordGET(new Request(`https://vet.example.com/api/records/${created.recordId}`), idParams(created.recordId));
    const activeRecord = (await pollActive.json()).record as {chain: {blockNumber?: number; blockTime?: string}};
    expect(activeRecord.chain.blockNumber).toBe(12345);
    expect(new Date(activeRecord.chain.blockTime!).toISOString()).toBe(anchoredBlockTime.toISOString());

    // Idempotent repeat confirm.
    const confirmAgain = await confirmPOST(new Request(`https://vet.example.com/api/records/${created.recordId}/confirm`, {method: "POST"}), idParams(created.recordId));
    expect(confirmAgain.status).toBe(200);
    expect((await confirmAgain.json()).status).toBe("active");

    // 4. ATTESTATION - GET builds the EIP-712 payload; POST is signed with a real local account
    // and independently recovered server-side against issuedBy(root).
    vi.mocked(chainRead.readRecordTypeVaccination).mockResolvedValue(VACCINATION_RECORD_TYPE_HASH);
    vi.mocked(chainRead.readIssuedBy).mockResolvedValue(OPERATOR);

    const account = privateKeyToAccount(`0x${"7".repeat(64)}`);
    // The operator wallet this record was drafted for and confirmed against IS this account -
    // issuedBy(root) is mocked to match it, exactly mirroring a real anchoring operator.
    vi.mocked(chainRead.readIssuedBy).mockImplementation(async () => account.address);

    // `as Promise<Response>`: attestationGET's inferred return type carries a spurious `| undefined`
    // from TypeScript's `in` narrowing over buildRecordAttestationPayload's (route.ts, not test
    // code) inferred union return type - every actual branch returns a real NextResponse (confirmed
    // by reading the full source). Same known artifact `issuanceRouteGuards.integration.test.ts`
    // already documents for the tag attestation route's identical `{error} | {...}` shape.
    const attestGetRes = await (attestationGET(
      new Request(`https://vet.example.com/api/records/${created.recordId}/attestation`),
      idParams(created.recordId),
    ) as Promise<Response>);
    expect(attestGetRes.status).toBe(200);
    const payload = (await attestGetRes.json()) as {
      domain: {name: string; version: string; chainId: number; verifyingContract: `0x${string}`};
      types: {IssuerAttestation: readonly {name: string; type: string}[]};
      message: {merkleRoot: `0x${string}`; recordType: `0x${string}`; issuerContract: `0x${string}`; issuerName: string; issuerDomain: string};
    };
    expect(payload.message.merkleRoot).toBe(created.root);
    expect(payload.message.recordType).toBe(VACCINATION_RECORD_TYPE_HASH);
    expect(payload.message.issuerDomain).toBe("riverside.example");

    const signature = await account.signTypedData({
      domain: payload.domain,
      types: payload.types,
      primaryType: "IssuerAttestation",
      message: payload.message,
    });

    // Same spurious `| undefined` as attestGetRes above.
    const attestPostRes = await (attestationPOST(
      jsonRequest(`https://vet.example.com/api/records/${created.recordId}/attestation`, {signature}),
      idParams(created.recordId),
    ) as Promise<Response>);
    expect(attestPostRes.status).toBe(200);
    const attestResult = (await attestPostRes.json()) as {ok: boolean; issuerSigner: string};
    expect(attestResult.ok).toBe(true);
    expect(attestResult.issuerSigner.toLowerCase()).toBe(account.address.toLowerCase());

    const finalDoc = await RecordArtifact.findOne({recordId: created.recordId}).lean<RecordArtifactDoc>();
    expect(finalDoc?.attestation?.signature).toBe(signature);
    expect(finalDoc?.attestation?.message.recordType).toBe(VACCINATION_RECORD_TYPE_HASH);

    // GET /api/pets/:id/records now lists it.
    const listRes = await listGET(new Request(`https://vet.example.com/api/pets/${petId}/records`), idParams(petId));
    const {records} = (await listRes.json()) as {records: RecordArtifactDoc[]};
    expect(records).toHaveLength(1);
    expect(records[0]?.recordId).toBe(created.recordId);
  });
});

describe("the wallet-switch guard (tx route)", () => {
  it("refuses to record a txHash sent from a DIFFERENT wallet than the one the record was drafted for", async () => {
    const petId = randomUUID();
    await withStaffSession("vet");
    await seedClinicAndPet(petId);
    const createRes = await createPOST(
      jsonRequest(`https://vet.example.com/api/pets/${petId}/records`, {operatorAddress: OPERATOR, form: VALID_FORM}),
      idParams(petId),
    );
    const {record: created} = (await createRes.json()) as {record: RecordArtifactDoc};

    const txRes = await txPOST(
      jsonRequest(`https://vet.example.com/api/records/${created.recordId}/tx`, {txHash: `0x${"2".repeat(64)}`, operatorAddress: OTHER_OPERATOR}),
      idParams(created.recordId),
    );
    expect(txRes.status).toBe(400);
    expect((await txRes.json()).error.message).toContain("does not match the operator this record was drafted for");

    const stillDraft = await RecordArtifact.findOne({recordId: created.recordId}).lean<RecordArtifactDoc>();
    expect(stillDraft?.status).toBe("draft");
  });
});

describe("confirm - fail-closed", () => {
  async function draftedAndIssuing(petId: string): Promise<RecordArtifactDoc> {
    await withStaffSession("vet");
    await seedClinicAndPet(petId);
    const createRes = await createPOST(
      jsonRequest(`https://vet.example.com/api/pets/${petId}/records`, {operatorAddress: OPERATOR, form: VALID_FORM}),
      idParams(petId),
    );
    const {record: created} = (await createRes.json()) as {record: RecordArtifactDoc};
    vi.mocked(chainRead.readTxReceiptStatus).mockResolvedValue("pending");
    await txPOST(
      jsonRequest(`https://vet.example.com/api/records/${created.recordId}/tx`, {txHash: `0x${"3".repeat(64)}`, operatorAddress: OPERATOR}),
      idParams(created.recordId),
    );
    return created;
  }

  it("a chain read that THROWS is transient (202), and leaves the record's status untouched", async () => {
    const petId = randomUUID();
    const created = await draftedAndIssuing(petId);
    vi.mocked(chainRead.readRootIssuer).mockRejectedValue(new Error("RPC timeout"));

    const res = await confirmPOST(new Request(`https://vet.example.com/api/records/${created.recordId}/confirm`, {method: "POST"}), idParams(created.recordId));
    expect(res.status).toBe(202);
    const stillIssuing = await RecordArtifact.findOne({recordId: created.recordId}).lean<RecordArtifactDoc>();
    expect(stillIssuing?.status).toBe("issuing");
  });

  it("rootIssuer resolving to the ZERO address (never indexed) is not-anchored -> error", async () => {
    const petId = randomUUID();
    const created = await draftedAndIssuing(petId);
    vi.mocked(chainRead.readRootIssuer).mockResolvedValue("0x0000000000000000000000000000000000000000");

    const res = await confirmPOST(new Request(`https://vet.example.com/api/records/${created.recordId}/confirm`, {method: "POST"}), idParams(created.recordId));
    expect(res.status).toBe(400);
    const errored = await RecordArtifact.findOne({recordId: created.recordId}).lean<RecordArtifactDoc>();
    expect(errored?.status).toBe("error");
    expect(errored?.errorStage).toBe("verify");
  });

  it("recordTypeOf returning the ALL-ZERO word is a FAILURE, never a pass, even when the other three reads agree", async () => {
    const petId = randomUUID();
    const created = await draftedAndIssuing(petId);
    vi.mocked(chainRead.readRootIssuer).mockResolvedValue(OUR_CLONE);
    vi.mocked(chainRead.readIsValidRoot).mockResolvedValue(true);
    vi.mocked(chainRead.readRecordTypeOf).mockResolvedValue(ZERO_HEX32);
    vi.mocked(chainRead.readIssuedBy).mockResolvedValue(OPERATOR);

    const res = await confirmPOST(new Request(`https://vet.example.com/api/records/${created.recordId}/confirm`, {method: "POST"}), idParams(created.recordId));
    expect(res.status).toBe(400);
    const errored = await RecordArtifact.findOne({recordId: created.recordId}).lean<RecordArtifactDoc>();
    expect(errored?.status).toBe("error");
  });

  it("issuedBy disagreeing with the committed issuer.operator leaf refuses, even when isValid/recordTypeOf/rootIssuer all agree", async () => {
    const petId = randomUUID();
    const created = await draftedAndIssuing(petId);
    vi.mocked(chainRead.readRootIssuer).mockResolvedValue(OUR_CLONE);
    vi.mocked(chainRead.readIsValidRoot).mockResolvedValue(true);
    vi.mocked(chainRead.readRecordTypeOf).mockResolvedValue(VACCINATION_RECORD_TYPE_HASH);
    vi.mocked(chainRead.readIssuedBy).mockResolvedValue(OTHER_OPERATOR);

    const res = await confirmPOST(new Request(`https://vet.example.com/api/records/${created.recordId}/confirm`, {method: "POST"}), idParams(created.recordId));
    expect(res.status).toBe(400);
  });

  it("rootIssuer resolving to a DIFFERENT clone than this clinic's own refuses (never trusts a clone the caller names)", async () => {
    const petId = randomUUID();
    const created = await draftedAndIssuing(petId);
    vi.mocked(chainRead.readRootIssuer).mockResolvedValue("0x00000000000000000000000000000000000ff1ce");
    vi.mocked(chainRead.readIsValidRoot).mockResolvedValue(true);
    vi.mocked(chainRead.readRecordTypeOf).mockResolvedValue(VACCINATION_RECORD_TYPE_HASH);
    vi.mocked(chainRead.readIssuedBy).mockResolvedValue(OPERATOR);

    const res = await confirmPOST(new Request(`https://vet.example.com/api/records/${created.recordId}/confirm`, {method: "POST"}), idParams(created.recordId));
    expect(res.status).toBe(400);
  });

  // Grade round 1 D2 (MAJOR, coverage): the plan's own non-negotiable names FOUR chain reads that
  // must all agree (rootIssuer, isValid, recordTypeOf, issuedBy). Before this pair, only two of the
  // four had a test where deleting the production `&&` conjunct for that check would turn anything
  // red - the existing "recordTypeOf ALL-ZERO" case above is caught by reconcile.ts's separate,
  // explicitly-defensive `!== ZERO_HEX32` guard, never by the equality comparison itself, and no
  // test anywhere set `isValid` to `false` while the other three agreed. `pnpm test` stayed fully
  // green with either `valid &&` or the `recordTypeOf` equality conjunct deleted from
  // `reconcileAnchoredRecord`'s `agrees` - exactly the silent-regression class the plan calls out
  // by name. Bite (run once per test, confirmed, no production line changed - see the FIX ROUND 1
  // progress log for the exact commands): deleting `valid &&` turns only the first test below red;
  // separately deleting the `recordTypeOf` equality conjunct turns only the second test below red.
  it("isValid(root) returning false refuses even when rootIssuer/recordTypeOf/issuedBy all agree - never active", async () => {
    const petId = randomUUID();
    const created = await draftedAndIssuing(petId);
    vi.mocked(chainRead.readTxReceiptStatus).mockResolvedValue("success");
    vi.mocked(chainRead.readRootIssuer).mockResolvedValue(OUR_CLONE);
    vi.mocked(chainRead.readIsValidRoot).mockResolvedValue(false);
    vi.mocked(chainRead.readRecordTypeOf).mockResolvedValue(VACCINATION_RECORD_TYPE_HASH);
    vi.mocked(chainRead.readIssuedBy).mockResolvedValue(OPERATOR);

    const res = await confirmPOST(new Request(`https://vet.example.com/api/records/${created.recordId}/confirm`, {method: "POST"}), idParams(created.recordId));
    expect(res.status).toBe(400);
    const errored = await RecordArtifact.findOne({recordId: created.recordId}).lean<RecordArtifactDoc>();
    expect(errored?.status).toBe("error");
    expect(errored?.errorStage).toBe("verify");
  });

  it("recordTypeOf(root) returning a NON-ZERO but WRONG word refuses, even when rootIssuer/isValid/issuedBy all agree (a non-zero wrong value bites where the all-zero case above cannot)", async () => {
    const petId = randomUUID();
    const created = await draftedAndIssuing(petId);
    // Any 32-byte value that is neither ZERO_HEX32 nor VACCINATION_RECORD_TYPE_HASH - what matters
    // is that it is a well-formed, genuinely non-zero word the equality conjunct alone must reject,
    // not that it is any particular record type's real hash.
    const wrongButNonZeroRecordTypeHash = `0x${"1".repeat(63)}2`;
    vi.mocked(chainRead.readTxReceiptStatus).mockResolvedValue("success");
    vi.mocked(chainRead.readRootIssuer).mockResolvedValue(OUR_CLONE);
    vi.mocked(chainRead.readIsValidRoot).mockResolvedValue(true);
    vi.mocked(chainRead.readRecordTypeOf).mockResolvedValue(wrongButNonZeroRecordTypeHash);
    vi.mocked(chainRead.readIssuedBy).mockResolvedValue(OPERATOR);

    const res = await confirmPOST(new Request(`https://vet.example.com/api/records/${created.recordId}/confirm`, {method: "POST"}), idParams(created.recordId));
    expect(res.status).toBe(400);
    const errored = await RecordArtifact.findOne({recordId: created.recordId}).lean<RecordArtifactDoc>();
    expect(errored?.status).toBe("error");
    expect(errored?.errorStage).toBe("verify");
  });

  it("a CONFIRMED revert bounces the record back to draft (redraft never needed - leaves/root already verified)", async () => {
    const petId = randomUUID();
    const created = await draftedAndIssuing(petId);
    vi.mocked(chainRead.readTxReceiptStatus).mockResolvedValue("reverted");

    const res = await confirmPOST(new Request(`https://vet.example.com/api/records/${created.recordId}/confirm`, {method: "POST"}), idParams(created.recordId));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("draft");
    const reverted = await RecordArtifact.findOne({recordId: created.recordId}).lean<RecordArtifactDoc>();
    expect(reverted?.status).toBe("draft");
    expect(reverted?.chain.txHash).toBeUndefined();
  });

  it("a THROWING anchoring-metadata read never blocks a genuine confirmation - it only leaves blockNumber/blockTime absent", async () => {
    const petId = randomUUID();
    const created = await draftedAndIssuing(petId);
    vi.mocked(chainRead.readTxReceiptStatus).mockResolvedValue("success");
    vi.mocked(chainRead.readRootIssuer).mockResolvedValue(OUR_CLONE);
    vi.mocked(chainRead.readIsValidRoot).mockResolvedValue(true);
    vi.mocked(chainRead.readRecordTypeOf).mockResolvedValue(VACCINATION_RECORD_TYPE_HASH);
    vi.mocked(chainRead.readIssuedBy).mockResolvedValue(OPERATOR);
    vi.mocked(chainRead.readTxAnchoring).mockRejectedValue(new Error("RPC timeout reading block"));

    const res = await confirmPOST(new Request(`https://vet.example.com/api/records/${created.recordId}/confirm`, {method: "POST"}), idParams(created.recordId));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("active");
    const active = await RecordArtifact.findOne({recordId: created.recordId}).lean<RecordArtifactDoc>();
    expect(active?.status).toBe("active");
    expect(active?.chain.blockNumber).toBeUndefined();
    expect(active?.chain.blockTime).toBeUndefined();
  });

  it("missing VET_ISSUER_FACTORY_ADDRESS refuses the confirm rather than silently skipping the rootIssuer read", async () => {
    const petId = randomUUID();
    const created = await draftedAndIssuing(petId);
    // See this file's header note on why a plain `delete process.env.X` cannot exercise this path
    // once `getServerEnv()` has already cached a snapshot (every earlier test already triggered
    // that) - `requireEnv` itself is mocked instead, for exactly this one call, to genuinely throw
    // the way it would on a deployment that never configured this variable at all.
    vi.mocked(envModule.requireEnv).mockImplementationOnce(() => {
      throw new Error("Missing required environment variable VET_ISSUER_FACTORY_ADDRESS. See .env.example for the full list.");
    });

    const res = await confirmPOST(new Request(`https://vet.example.com/api/records/${created.recordId}/confirm`, {method: "POST"}), idParams(created.recordId));
    expect(res.status).toBe(400);
    const untouched = await RecordArtifact.findOne({recordId: created.recordId}).lean<RecordArtifactDoc>();
    expect(untouched?.status).toBe("issuing");
  });
});
