import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.13 item 2 - `PATCH /api/settings/staff/me/profile`, the self-service counterpart to the
 * owner-only `PATCH /api/settings/staff/:staffId` (Kenneth issue 3: split the vet's display name
 * into first/last, plus a title/qualification and a government accreditation number). Modelled
 * directly on `tests/unit/api/selfWalletRoute.integration.test.ts`'s own conventions
 * (`vi.mock("@/auth")` + `startEphemeralMongod` on a free port > 44000 - 44134, the next free one
 * per that file's own port ledger comment, 44117-44133 already taken by sibling suites as of this
 * WP).
 *
 * Mirrors selfWalletRoute's own describe shape: a 401/403 role matrix, a self-only-scope block, a
 * validation block, and a clearing/scope block proving this route reuses `setStaffProfile`'s
 * existing `$unset` contract rather than reimplementing it.
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));

import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {Staff, type StaffDoc, type StaffRole} from "@/lib/models/Staff";
import {PATCH} from "@/app/api/settings/staff/me/profile/route";

const MONGO_PORT = 44_134;

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-wp413-self-profile");
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
  return new Request("https://vet.example.com/api/settings/staff/me/profile", {
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

describe("PATCH /api/settings/staff/me/profile - 403/401 matrix", () => {
  it("401s with no session at all", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await PATCH(patchRequest({firstName: "Jane"}));
    expect(res.status).toBe(401);
  });

  it("403s a plain staff role", async () => {
    const staff = await createStaff("staff");
    signInAs(staff);
    const res = await PATCH(patchRequest({firstName: "Jane"}));
    expect(res.status).toBe(403);
  });

  it("403s a disabled vet (role alone is not enough - requireVetSession re-reads Mongo)", async () => {
    const staff = await createStaff("vet", true);
    signInAs(staff);
    const res = await PATCH(patchRequest({firstName: "Jane"}));
    expect(res.status).toBe(403);
  });

  it("403s a disabled owner the same way", async () => {
    const staff = await createStaff("owner", true);
    signInAs(staff);
    const res = await PATCH(patchRequest({firstName: "Jane"}));
    expect(res.status).toBe(403);
  });

  it("allows an active vet", async () => {
    const staff = await createStaff("vet");
    signInAs(staff);
    const res = await PATCH(patchRequest({firstName: "Jane"}));
    expect(res.status).toBe(200);
  });

  it("allows an active owner (an owner may also be a practitioner)", async () => {
    const staff = await createStaff("owner");
    signInAs(staff);
    const res = await PATCH(patchRequest({firstName: "Jane"}));
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/settings/staff/me/profile - self-only scope", () => {
  it("only ever touches the CALLER's own row, never another vet's", async () => {
    const caller = await createStaff("vet");
    const other = await createStaff("vet", false, {firstName: "Other", lastName: "Vet"});
    signInAs(caller);

    const res = await PATCH(patchRequest({firstName: "Jane", lastName: "Smith"}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as StaffDoc;
    expect(body.staffId).toBe(caller.staffId);
    expect(body.firstName).toBe("Jane");
    expect(body.lastName).toBe("Smith");

    const otherAfter = await Staff.findOne({staffId: other.staffId}).lean<StaffDoc>();
    expect(otherAfter?.firstName).toBe("Other");
    expect(otherAfter?.lastName).toBe("Vet");
  });

  it("cannot smuggle a role through this endpoint - the schema is .strict()", async () => {
    const staff = await createStaff("vet");
    signInAs(staff);
    const res = await PATCH(patchRequest({firstName: "Jane", role: "owner"}));
    expect(res.status).toBe(400);
    const staffAfter = await Staff.findOne({staffId: staff.staffId}).lean<StaffDoc>();
    expect(staffAfter?.role).toBe("vet");
    expect(staffAfter?.firstName).toBeUndefined();
  });

  it("cannot smuggle bookable through this endpoint - bookable stays owner-only", async () => {
    const staff = await createStaff("vet");
    signInAs(staff);
    const res = await PATCH(patchRequest({firstName: "Jane", bookable: true}));
    expect(res.status).toBe(400);
    const staffAfter = await Staff.findOne({staffId: staff.staffId}).lean<StaffDoc>();
    expect(staffAfter?.bookable).toBe(false);
  });

  it("cannot smuggle walletAddress through this endpoint - wallet stays on the sibling /me/wallet route", async () => {
    const staff = await createStaff("vet");
    signInAs(staff);
    const res = await PATCH(patchRequest({firstName: "Jane", walletAddress: "0x1234567890123456789012345678901234567890"}));
    expect(res.status).toBe(400);
    const staffAfter = await Staff.findOne({staffId: staff.staffId}).lean<StaffDoc>();
    expect(staffAfter?.walletAddress).toBeUndefined();
  });
});

describe("PATCH /api/settings/staff/me/profile - validation", () => {
  it("400s an empty body (at least one field required)", async () => {
    const staff = await createStaff("vet");
    signInAs(staff);
    const res = await PATCH(patchRequest({}));
    expect(res.status).toBe(400);
  });

  it("400s an unparseable JSON body", async () => {
    const staff = await createStaff("vet");
    signInAs(staff);
    const res = await PATCH(
      new Request("https://vet.example.com/api/settings/staff/me/profile", {
        method: "PATCH",
        headers: {"content-type": "application/json"},
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("400s an empty-string field (would silently blank it rather than being rejected)", async () => {
    const staff = await createStaff("vet");
    signInAs(staff);
    const res = await PATCH(patchRequest({firstName: ""}));
    expect(res.status).toBe(400);
  });

  it("400s a title over the 40-character limit", async () => {
    const staff = await createStaff("vet");
    signInAs(staff);
    const res = await PATCH(patchRequest({title: "x".repeat(41)}));
    expect(res.status).toBe(400);
  });

  it("400s an accreditationNumber over the 64-character limit", async () => {
    const staff = await createStaff("vet");
    signInAs(staff);
    const res = await PATCH(patchRequest({accreditationNumber: "x".repeat(65)}));
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/settings/staff/me/profile - clearing and scope, reusing setStaffProfile's existing contract", () => {
  it("clears a previously-recorded field when it is explicitly null ($unset, not empty string)", async () => {
    const staff = await createStaff("vet", false, {title: "DVM"});
    signInAs(staff);
    const res = await PATCH(patchRequest({title: null}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as StaffDoc;
    expect(body.title).toBeUndefined();

    const raw = await Staff.collection.findOne({staffId: staff.staffId});
    expect(Object.prototype.hasOwnProperty.call(raw ?? {}, "title")).toBe(false);
  });

  it("can set several fields at once, and clear one while setting another in the same request", async () => {
    const staff = await createStaff("vet", false, {title: "DVM", accreditationNumber: "OLD-1"});
    signInAs(staff);
    const res = await PATCH(patchRequest({firstName: "Jane", lastName: "Smith", title: null, accreditationNumber: "USDA-1234"}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as StaffDoc;
    expect(body.firstName).toBe("Jane");
    expect(body.lastName).toBe("Smith");
    expect(body.title).toBeUndefined();
    expect(body.accreditationNumber).toBe("USDA-1234");
  });

  it("leaves bookable/displayName/walletAddress untouched - this route only ever writes firstName/lastName/title/accreditationNumber", async () => {
    const staff = await createStaff("vet", false, {
      bookable: true,
      displayName: "Dr. Blaze",
      walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    signInAs(staff);
    const res = await PATCH(patchRequest({firstName: "Jane", lastName: "Smith", title: "DVM", accreditationNumber: "USDA-1234"}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as StaffDoc;
    expect(body.bookable).toBe(true);
    expect(body.displayName).toBe("Dr. Blaze");
    expect(body.walletAddress).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(body.firstName).toBe("Jane");
    expect(body.lastName).toBe("Smith");
    expect(body.title).toBe("DVM");
    expect(body.accreditationNumber).toBe("USDA-1234");
  });
});
