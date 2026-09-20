import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.7 A4/D5 - the ONE property the plan is strictest about: `GET /v1/booking/availability`'s
 * clinic-mode response must be wire-IDENTICAL to before this WP (no `practitioners` key, no
 * per-slot `practitionerIds` key, not even as empty/undefined - old clients, including the WP4.4
 * mobile app's own decoder, must never see a shape they don't recognize). Invokes the route
 * handler directly (Next.js route handlers are plain async functions over the Fetch API's
 * Request/Response, callable outside the Next dev/prod server) against a real ephemeral mongod -
 * this is the one place that actually proves the ROUTE composes `computeAvailability`/
 * `computePractitionerAvailability` correctly, as opposed to the pure functions themselves
 * (already covered in `availability.test.ts` and `practitionerAvailability.test.ts`).
 *
 * ISOLATION: own ephemeral mongod, port 44121 (44117-44120 already taken by sibling suites).
 */
import {connectToDatabase} from "@/lib/db";
import {AvailabilityException, AvailabilityRule, BookingSettings} from "@/lib/models/Availability";
import {Service} from "@/lib/models/Service";
import {Staff} from "@/lib/models/Staff";
import {GET} from "@/app/v1/booking/availability/route";

const MONGO_PORT = 44_121;

let ephemeral: EphemeralMongod;
let serviceId: string;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-wp47-availability-wire");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);

  const service = await Service.create({
    name: "Checkup",
    durationMinutes: 30,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    active: true,
    bookableOnline: true,
  });
  serviceId = service.serviceId;
}, 90_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Promise.all([AvailabilityRule.deleteMany({}), AvailabilityException.deleteMany({}), Staff.deleteMany({})]);
});

// The route reads the REAL clock (`Date.now()`) internally for its minNotice/maxAdvance filtering
// - unlike the pure `computeAvailability`/`computePractitionerAvailability` tests, which inject a
// fixed `now`, this test cannot use a hardcoded calendar date at all (a hardcoded 2026 date is
// already in the past by the time this suite runs later in 2026 and beyond, which silently filters
// out every candidate slot via minNoticeMinutes - the exact bug this comment exists to warn the
// next person off). Instead, find the next Thursday at least a week out, comfortably clearing the
// default singleton's 60-minute minNotice and well inside its 60-day maxAdvance.
function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nextThursdayRangeAtLeastAWeekOut(): {fromIso: string; toIso: string} {
  const now = new Date();
  const daysUntilNextThursday = ((4 - now.getUTCDay() + 7) % 7) + 7; // +7: always at least a week out
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilNextThursday));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1));
  return {fromIso: `${isoDate(start)}T00:00:00.000-05:00`, toIso: `${isoDate(end)}T00:00:00.000-05:00`};
}

const THURSDAY = 4;
const {fromIso, toIso} = nextThursdayRangeAtLeastAWeekOut();

function requestUrl(): string {
  return `https://vet.example.com/v1/booking/availability?serviceId=${serviceId}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
}

describe("GET /v1/booking/availability - clinic mode wire shape (byte parity)", () => {
  it("never includes practitioners or per-slot practitionerIds - clinic mode is the default with no BookingSettings row at all", async () => {
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, capacity: 1});
    const res = await GET(new Request(requestUrl()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty("practitioners");
    expect(Array.isArray(body.slots)).toBe(true);
    expect(body.slots.length).toBeGreaterThan(0);
    for (const slot of body.slots) {
      expect(Object.keys(slot).sort()).toEqual(["endAt", "startAt"]);
    }
  });

  it("still excludes practitioners/practitionerIds when schedulingMode is explicitly clinic", async () => {
    await BookingSettings.findByIdAndUpdate("singleton", {$set: {schedulingMode: "clinic"}}, {upsert: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, capacity: 1});
    const res = await GET(new Request(requestUrl()));
    const body = await res.json();
    expect(body).not.toHaveProperty("practitioners");
    expect(body.slots[0]).not.toHaveProperty("practitionerIds");
  });
});

describe("GET /v1/booking/availability - practitioner mode wire shape", () => {
  it("includes a practitioners roster and per-slot practitionerIds", async () => {
    await BookingSettings.findByIdAndUpdate("singleton", {$set: {schedulingMode: "practitioner"}}, {upsert: true});
    const vet = await Staff.create({email: "a@example.com", role: "vet", bookable: true, displayName: "Dr. A"});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vet.staffId});

    const res = await GET(new Request(requestUrl()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.practitioners).toEqual([{id: vet.staffId, name: "Dr. A"}]);
    expect(body.slots.length).toBeGreaterThan(0);
    for (const slot of body.slots) {
      expect(slot.practitionerIds).toEqual([vet.staffId]);
    }
  });

  it("returns an empty practitioners roster and no slots when nobody is bookable", async () => {
    await BookingSettings.findByIdAndUpdate("singleton", {$set: {schedulingMode: "practitioner"}}, {upsert: true});
    const res = await GET(new Request(requestUrl()));
    const body = await res.json();
    expect(body.practitioners).toEqual([]);
    expect(body.slots).toEqual([]);
  });

  /**
   * WP4.13 - the plan's own strictest wire property, re-verified after this WP's changes:
   * `PractitionerSummary` gained `initials` and `Staff` gained `firstName`/`lastName`/`title`/
   * `accreditationNumber`, and NONE of that may leak onto this response. `initials` is internal
   * (calendar-only); `accreditationNumber` is internal to Settings entirely (never public, by
   * this WP's own settlement). The route's own mapping (`{id: p.staffId, name: p.name}`, never a
   * spread of `p`) is what keeps this true - this test proves it holds even with every new field
   * populated, not merely when they are absent.
   */
  it("never leaks initials or accreditationNumber - the wire stays exactly {id, name} even with a full WP4.13 profile on file", async () => {
    await BookingSettings.findByIdAndUpdate("singleton", {$set: {schedulingMode: "practitioner"}}, {upsert: true});
    const vet = await Staff.create({
      email: "full-profile@example.com",
      role: "vet",
      bookable: true,
      firstName: "Jane",
      lastName: "Smith",
      title: "DVM",
      accreditationNumber: "USDA-1234",
    });
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vet.staffId});

    const res = await GET(new Request(requestUrl()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.practitioners).toEqual([{id: vet.staffId, name: "Jane Smith, DVM"}]);
    for (const practitioner of body.practitioners) {
      expect(Object.keys(practitioner).sort()).toEqual(["id", "name"]);
    }
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("USDA-1234");
    expect(raw).not.toContain("initials");
    expect(raw).not.toContain("accreditationNumber");
  });
});
