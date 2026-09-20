import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * `POST /api/records/:id/lifecycle` (plan section 11.2 V4's "revoke (owner/vet with reason ->
 * clone.revokeRecord + confirm)") - mirrors `api/tags/[petId]/lifecycle/route.ts`'s own re-read-the-
 * chain-before-trusting-the-tx pattern, keyed by RECORD id rather than pet id (a pet has many
 * independent records - see the route's own header comment for why).
 *
 * ISOLATION: own ephemeral mongod, port 44143 (WP4.17A D7: moved off 44138, which duplicated
 * primaryOwnerClientIdIssuanceStart.integration.test.ts's own port - see this file's own
 * port-constant comment).
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));
vi.mock("@/lib/chainRead", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chainRead")>();
  return {...actual, readIsValidRoot: vi.fn()};
});

import {auth} from "@/auth";
import * as chainRead from "@/lib/chainRead";
import {connectToDatabase} from "@/lib/db";
import {Staff} from "@/lib/models/Staff";
import {RecordArtifact, type RecordArtifactDoc} from "@/lib/models/RecordArtifact";
import {ChainActivity, type ChainActivityDoc} from "@/lib/models/ChainActivity";
import {POST as lifecyclePOST} from "@/app/api/records/[id]/lifecycle/route";

// WP4.17A D7 - was 44138, duplicating primaryOwnerClientIdIssuanceStart.integration.test.ts's own
// port (see recordIssuance.integration.test.ts's identical comment for the full audit).
const MONGO_PORT = 44_143;

// 0x + 40 hex chars, generated + regex-verified with `python3 -c` before use (a too-short/non-hex
// placeholder is an easy transcription mistake - see recordIssuance.integration.test.ts's own
// header note, and this file's own earlier draft, which was wrong on the first two tries).
const OUR_CLONE = "0x0000000000000000000000000000000000c10be5";
const OPERATOR = "0x0000000000000000000000000000000000000ff1";
const ROOT = `0x${"9".repeat(64)}`;
const TX_HASH = `0x${"5".repeat(64)}`;

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-record-lifecycle");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  await RecordArtifact.init();
}, 90_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Promise.all([Staff.deleteMany({}), RecordArtifact.deleteMany({}), ChainActivity.deleteMany({})]);
  vi.mocked(auth).mockReset();
  vi.mocked(chainRead.readIsValidRoot).mockReset();
});

async function withStaffSession(role: "vet" | "owner" | "staff"): Promise<void> {
  const staff = await Staff.create({email: `${role}-${randomUUID()}@example.com`, role, firstName: "Jane", lastName: "Tan"});
  vi.mocked(auth).mockResolvedValue({user: {staffId: staff.staffId}} as never);
}

async function createActiveRecord(): Promise<RecordArtifactDoc> {
  const created = await RecordArtifact.create({
    petId: randomUUID(),
    dogTagIdField: "424242",
    recordType: "VACCINATION",
    schemaId: "https://dogtag.io/schemas/vaccination/v1",
    schemaVersion: "1.0.0",
    protocolVersion: "dogtag-v2/1",
    root: ROOT,
    leaves: [],
    nonMaskable: [],
    status: "active",
    chain: {chainId: 1337, contract: OUR_CLONE, operator: OPERATOR},
  });
  return created.toObject();
}

function idParams(id: string): {params: Promise<{id: string}>} {
  return {params: Promise.resolve({id})};
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
}

describe("POST /api/records/:id/lifecycle", () => {
  it("a plain staff member (not vet/owner) gets 403", async () => {
    const record = await createActiveRecord();
    await withStaffSession("staff");
    const res = await lifecyclePOST(
      jsonRequest(`https://vet.example.com/api/records/${record.recordId}/lifecycle`, {reasonCode: "REASON_OWNER_REQUEST", txHash: TX_HASH}),
      idParams(record.recordId),
    );
    expect(res.status).toBe(403);
  });

  it("an unrecognized reasonCode is rejected", async () => {
    const record = await createActiveRecord();
    await withStaffSession("vet");
    const res = await lifecyclePOST(
      jsonRequest(`https://vet.example.com/api/records/${record.recordId}/lifecycle`, {reasonCode: "NOT_A_REAL_CODE", txHash: TX_HASH}),
      idParams(record.recordId),
    );
    expect(res.status).toBe(400);
  });

  it("revokes when the chain confirms isValid(root) is now false - vet role", async () => {
    const record = await createActiveRecord();
    await withStaffSession("vet");
    vi.mocked(chainRead.readIsValidRoot).mockResolvedValue(false);

    const res = await lifecyclePOST(
      jsonRequest(`https://vet.example.com/api/records/${record.recordId}/lifecycle`, {reasonCode: "REASON_OWNER_REQUEST", txHash: TX_HASH}),
      idParams(record.recordId),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("revoked");

    const stored = await RecordArtifact.findOne({recordId: record.recordId}).lean<RecordArtifactDoc>();
    expect(stored?.status).toBe("revoked");
    expect(stored?.revokedReason).toBe("REASON_OWNER_REQUEST");
    expect(stored?.revokedAt).toBeInstanceOf(Date);

    const activity = await ChainActivity.findOne({txHash: TX_HASH}).lean<ChainActivityDoc>();
    expect(activity?.type).toBe("RecordRevoked");
    expect(activity?.root).toBe(ROOT);
  });

  it("owner role can also revoke (owner/vet, per the checklist)", async () => {
    const record = await createActiveRecord();
    await withStaffSession("owner");
    vi.mocked(chainRead.readIsValidRoot).mockResolvedValue(false);

    const res = await lifecyclePOST(
      jsonRequest(`https://vet.example.com/api/records/${record.recordId}/lifecycle`, {reasonCode: "REASON_ERROR_CORRECTION", txHash: TX_HASH}),
      idParams(record.recordId),
    );
    expect(res.status).toBe(200);
  });

  it("refuses (400) when the chain still reports isValid(root) === true - the tx has not confirmed yet", async () => {
    const record = await createActiveRecord();
    await withStaffSession("vet");
    vi.mocked(chainRead.readIsValidRoot).mockResolvedValue(true);

    const res = await lifecyclePOST(
      jsonRequest(`https://vet.example.com/api/records/${record.recordId}/lifecycle`, {reasonCode: "REASON_OWNER_REQUEST", txHash: TX_HASH}),
      idParams(record.recordId),
    );
    expect(res.status).toBe(400);
    const stored = await RecordArtifact.findOne({recordId: record.recordId}).lean<RecordArtifactDoc>();
    expect(stored?.status).toBe("active");
  });

  it("a THROWING chain read refuses rather than trusting the tx blindly", async () => {
    const record = await createActiveRecord();
    await withStaffSession("vet");
    vi.mocked(chainRead.readIsValidRoot).mockRejectedValue(new Error("RPC timeout"));

    const res = await lifecyclePOST(
      jsonRequest(`https://vet.example.com/api/records/${record.recordId}/lifecycle`, {reasonCode: "REASON_OWNER_REQUEST", txHash: TX_HASH}),
      idParams(record.recordId),
    );
    expect(res.status).toBe(400);
  });

  it("refuses to revoke a record that is not currently active (e.g. already revoked, or still a draft)", async () => {
    const record = await createActiveRecord();
    await RecordArtifact.updateOne({recordId: record.recordId}, {$set: {status: "draft"}});
    await withStaffSession("vet");

    const res = await lifecyclePOST(
      jsonRequest(`https://vet.example.com/api/records/${record.recordId}/lifecycle`, {reasonCode: "REASON_OWNER_REQUEST", txHash: TX_HASH}),
      idParams(record.recordId),
    );
    expect(res.status).toBe(400);
  });

  it("404s for an unknown record id", async () => {
    await withStaffSession("vet");
    const res = await lifecyclePOST(
      jsonRequest(`https://vet.example.com/api/records/${randomUUID()}/lifecycle`, {reasonCode: "REASON_OWNER_REQUEST", txHash: TX_HASH}),
      idParams(randomUUID()),
    );
    expect(res.status).toBe(404);
  });
});
