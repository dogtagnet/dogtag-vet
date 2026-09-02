import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.7C item 2 - `PATCH /api/settings/staff/me/wallet`, the self-service counterpart to the
 * owner-only `PATCH /api/settings/staff/:staffId` (K2: "the vet can register their own...
 * address"). Modelled directly on `tests/unit/api/issuanceRouteGuards.integration.test.ts`'s own
 * conventions (`vi.mock("@/auth")` + `startEphemeralMongod` on a free port > 44000 - 44129, the
 * next free one per that file's own port ledger comment, 44117-44128 already taken by sibling
 * suites as of this WP).
 *
 * Item 2's own text asks for three things: "403 for plain staff, self-only scope, validation" -
 * each gets its own describe block below, plus a small "clears/lowercases" block proving this
 * route reuses `setStaffProfile`'s existing `$unset`/lowercase contract rather than reimplementing
 * it (this WP's own "extend, never duplicate" instruction).
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));

import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {Staff, type StaffDoc, type StaffRole} from "@/lib/models/Staff";
import {PATCH} from "@/app/api/settings/staff/me/wallet/route";

const MONGO_PORT = 44_129;

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-wp47c-self-wallet");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
}, 30_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Staff.deleteMany({});
  vi.mocked(auth).mockReset();
});

function patchRequest(body: unknown): Request {
  return new Request("https://vet.example.com/api/settings/staff/me/wallet", {
    method: "PATCH",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(body),
  });
}

async function createStaff(role: StaffRole, disabled = false, extra: Partial<StaffDoc> = {}): Promise<StaffDoc> {
  const created = await Staff.create({email: `${role}-${randomUUID()}@example.com`, role, disabled, ...extra});
  return created.toObject();
}

function signInAs(staff: StaffDoc): void {
  vi.mocked(auth).mockResolvedValue({user: {staffId: staff.staffId, email: staff.email}} as never);
}

const VALID_ADDRESS = "0x1234567890123456789012345678901234567890";

describe("PATCH /api/settings/staff/me/wallet - 403/401 matrix", () => {
  it("401s with no session at all", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await PATCH(patchRequest({walletAddress: VALID_ADDRESS}));
    expect(res.status).toBe(401);
  });

  it("403s a plain staff role", async () => {
    const staff = await createStaff("staff");
    signInAs(staff);
    const res = await PATCH(patchRequest({walletAddress: VALID_ADDRESS}));
    expect(res.status).toBe(403);
  });

  it("403s a disabled vet (role alone is not enough - requireVetSession re-reads Mongo)", async () => {
    const staff = await createStaff("vet", true);
    signInAs(staff);
    const res = await PATCH(patchRequest({walletAddress: VALID_ADDRESS}));
    expect(res.status).toBe(403);
  });

  it("403s a disabled owner the same way", async () => {
    const staff = await createStaff("owner", true);
    signInAs(staff);
    const res = await PATCH(patchRequest({walletAddress: VALID_ADDRESS}));
    expect(res.status).toBe(403);
  });

  it("allows an active vet", async () => {
    const staff = await createStaff("vet");
    signInAs(staff);
    const res = await PATCH(patchRequest({walletAddress: VALID_ADDRESS}));
    expect(res.status).toBe(200);
  });

  it("allows an active owner (D2: an owner may also be a practitioner)", async () => {
    const staff = await createStaff("owner");
    signInAs(staff);
    const res = await PATCH(patchRequest({walletAddress: VALID_ADDRESS}));
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/settings/staff/me/wallet - self-only scope", () => {
  it("only ever touches the CALLER's own row, never another vet's", async () => {
    const caller = await createStaff("vet");
    const other = await createStaff("vet", false, {walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"});
    signInAs(caller);

    const res = await PATCH(patchRequest({walletAddress: VALID_ADDRESS}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as StaffDoc;
    expect(body.staffId).toBe(caller.staffId);
    expect(body.walletAddress).toBe(VALID_ADDRESS.toLowerCase());

    const otherAfter = await Staff.findOne({staffId: other.staffId}).lean<StaffDoc>();
    expect(otherAfter?.walletAddress).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("cannot smuggle a role (or any other field) through this endpoint - the schema is .strict()", async () => {
    const staff = await createStaff("vet");
    signInAs(staff);
    const res = await PATCH(patchRequest({walletAddress: VALID_ADDRESS, role: "owner"}));
    expect(res.status).toBe(400);
    const staffAfter = await Staff.findOne({staffId: staff.staffId}).lean<StaffDoc>();
    expect(staffAfter?.role).toBe("vet");
    expect(staffAfter?.walletAddress).toBeUndefined();
  });
});

describe("PATCH /api/settings/staff/me/wallet - validation", () => {
  it("400s a malformed address with the SPECIFIC hex-format message, not a generic one", async () => {
    const staff = await createStaff("vet");
    signInAs(staff);
    const res = await PATCH(patchRequest({walletAddress: "not-a-real-address"}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("Must be a 0x-prefixed 40-hex-character address");
  });

  it("400s a body missing walletAddress entirely (the field is required, unlike the owner route's optional one)", async () => {
    const staff = await createStaff("vet");
    signInAs(staff);
    const res = await PATCH(patchRequest({}));
    expect(res.status).toBe(400);
  });

  it("400s an unparseable JSON body", async () => {
    const staff = await createStaff("vet");
    signInAs(staff);
    const res = await PATCH(
      new Request("https://vet.example.com/api/settings/staff/me/wallet", {
        method: "PATCH",
        headers: {"content-type": "application/json"},
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/settings/staff/me/wallet - reuses setStaffProfile's existing contract", () => {
  it("lowercases a mixed-case address on save, exactly like the owner route", async () => {
    const staff = await createStaff("vet");
    signInAs(staff);
    const mixedCase = "0xABCDEF1234567890ABCDEF1234567890ABCDEF12";
    const res = await PATCH(patchRequest({walletAddress: mixedCase}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as StaffDoc;
    expect(body.walletAddress).toBe(mixedCase.toLowerCase());
  });

  it("clears a previously-recorded wallet when walletAddress is explicitly null ($unset, not empty string)", async () => {
    const staff = await createStaff("vet", false, {walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"});
    signInAs(staff);
    const res = await PATCH(patchRequest({walletAddress: null}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as StaffDoc;
    expect(body.walletAddress).toBeUndefined();

    const raw = await Staff.collection.findOne({staffId: staff.staffId});
    expect(Object.prototype.hasOwnProperty.call(raw ?? {}, "walletAddress")).toBe(false);
  });

  it("leaves bookable/displayName untouched - this route only ever writes walletAddress", async () => {
    const staff = await createStaff("vet", false, {bookable: true, displayName: "Dr. Blaze"});
    signInAs(staff);
    const res = await PATCH(patchRequest({walletAddress: VALID_ADDRESS}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as StaffDoc;
    expect(body.bookable).toBe(true);
    expect(body.displayName).toBe("Dr. Blaze");
  });
});
