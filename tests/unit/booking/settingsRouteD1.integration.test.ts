import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.7 A5/D1 - `PATCH /api/availability/settings` must refuse a switch to `schedulingMode:
 * "practitioner"` unless at least one bookable practitioner already has at least one weekly rule
 * of their own (see `hasPractitionerReadyForSchedulingMode`'s doc comment in
 * src/lib/booking/queries.ts for why this is enforced server-side rather than only in the settings
 * UI). Invokes the route handler directly against a real ephemeral mongod, same pattern as
 * availabilityRouteWireShape.integration.test.ts.
 *
 * `@/auth` is mocked so requireStaffSession's session check passes without a real NextAuth session
 * - this route doesn't care WHICH staff role is signed in (any staff session may patch booking
 * settings today), only that one exists.
 *
 * ISOLATION: own ephemeral mongod, port 44122 (44117-44121 already taken by sibling suites).
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));

import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {AvailabilityRule, BookingSettings} from "@/lib/models/Availability";
import {Staff} from "@/lib/models/Staff";
import {PATCH} from "@/app/api/availability/settings/route";

const MONGO_PORT = 44_122;

let ephemeral: EphemeralMongod;

const FULL_SETTINGS_FIELDS = {
  timezone: "America/New_York",
  minNoticeMinutes: 60,
  maxAdvanceDays: 30,
  slotGranularityMinutes: 15,
};

function patchRequest(body: Record<string, unknown>): Request {
  return new Request("https://vet.example.com/api/availability/settings", {
    method: "PATCH",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-wp47-settings-d1");
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
  vi.mocked(auth).mockReset();
  await Promise.all([Staff.deleteMany({}), AvailabilityRule.deleteMany({}), BookingSettings.deleteMany({})]);
});

describe("PATCH /api/availability/settings - WP4.7 D1 precondition", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue({user: {staffId: "staff-1", email: "owner@example.com"}} as never);
  });

  it("refuses practitioner mode when there is no bookable practitioner at all", async () => {
    const res = await PATCH(patchRequest({...FULL_SETTINGS_FIELDS, schedulingMode: "practitioner"}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/bookable/i);
    expect(body.error.message).toMatch(/weekly hours/i);
  });

  it("refuses practitioner mode when a practitioner is bookable but has no weekly rule of their own", async () => {
    await Staff.create({email: "vet@example.com", role: "vet", bookable: true});
    const res = await PATCH(patchRequest({...FULL_SETTINGS_FIELDS, schedulingMode: "practitioner"}));
    expect(res.status).toBe(400);
  });

  it("refuses practitioner mode when a rule exists but only for a NON-bookable staff member", async () => {
    const staff = await Staff.create({email: "vet@example.com", role: "vet", bookable: false});
    await AvailabilityRule.create({dayOfWeek: 1, startMinute: 540, endMinute: 1020, staffId: staff.staffId});
    const res = await PATCH(patchRequest({...FULL_SETTINGS_FIELDS, schedulingMode: "practitioner"}));
    expect(res.status).toBe(400);
  });

  it("accepts practitioner mode once a bookable practitioner has at least one weekly rule", async () => {
    const vet = await Staff.create({email: "vet@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: 1, startMinute: 540, endMinute: 1020, staffId: vet.staffId});
    const res = await PATCH(patchRequest({...FULL_SETTINGS_FIELDS, schedulingMode: "practitioner"}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedulingMode).toBe("practitioner");
  });

  it("does not run the precondition at all when the patch omits schedulingMode", async () => {
    const res = await PATCH(patchRequest(FULL_SETTINGS_FIELDS));
    expect(res.status).toBe(200);
  });

  it("does not run the precondition when explicitly patching schedulingMode back to clinic", async () => {
    const res = await PATCH(patchRequest({...FULL_SETTINGS_FIELDS, schedulingMode: "clinic"}));
    expect(res.status).toBe(200);
  });

  it("re-checks the precondition on every save, not only the original switch", async () => {
    const vet = await Staff.create({email: "vet@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: 1, startMinute: 540, endMinute: 1020, staffId: vet.staffId});

    const first = await PATCH(patchRequest({...FULL_SETTINGS_FIELDS, schedulingMode: "practitioner"}));
    expect(first.status).toBe(200);

    await Staff.findOneAndUpdate({staffId: vet.staffId}, {$set: {bookable: false}});

    const second = await PATCH(patchRequest({...FULL_SETTINGS_FIELDS, schedulingMode: "practitioner"}));
    expect(second.status).toBe(400);
  });
});
