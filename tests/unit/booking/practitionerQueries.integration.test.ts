import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.7 A4 - the queries.ts practitioner-mode data loaders, against a real mongod (the
 * partitioning/filtering logic here is genuinely new query behavior, not a pure function
 * `computePractitionerAvailability`'s own unit tests already cover - these tests exercise the SQL/
 * Mongo-query-shape correctness those pure-function tests can't).
 *
 * Highest-value case: `loadAvailabilityConfig` (clinic mode's own config loader, otherwise
 * untouched) must exclude staffId-scoped rows even when they coexist with clinic-wide ones - this
 * is what keeps clinic-mode byte-parity genuinely true once a clinic has ever configured
 * per-practitioner mode, rather than merely true by accident of nobody having exercised it yet.
 *
 * ISOLATION: own ephemeral mongod, port 44119 (44117 = staleModelRepro, 44118 = wp47BackCompat).
 */
import {connectToDatabase} from "@/lib/db";
import {
  AvailabilityException,
  AvailabilityRule,
  BookingSettings,
} from "@/lib/models/Availability";
import {Appointment} from "@/lib/models/Appointment";
import {Staff} from "@/lib/models/Staff";
import {
  countPractitionerAppointmentsInRange,
  listBookablePractitioners,
  loadAvailabilityConfig,
  loadPractitionerOccupiedIntervals,
  loadPractitionerRulesAndExceptions,
} from "@/lib/booking/queries";

const MONGO_PORT = 44_119;

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-wp47-practitioner-queries");
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
  await Promise.all([
    AvailabilityRule.deleteMany({}),
    AvailabilityException.deleteMany({}),
    BookingSettings.deleteMany({}),
    Appointment.deleteMany({}),
    Staff.deleteMany({}),
  ]);
});

describe("loadAvailabilityConfig - excludes practitioner-scoped rows", () => {
  it("returns only staffId-absent rules/exceptions even when practitioner-scoped ones exist for the same dayOfWeek/date", async () => {
    await AvailabilityRule.create([
      {dayOfWeek: 2, startMinute: 540, endMinute: 1020}, // clinic-wide Tue 9-5
      {dayOfWeek: 2, startMinute: 0, endMinute: 1440, staffId: "vet-a"}, // vet-a's own, all-day - must NOT leak in
    ]);
    await AvailabilityException.create([
      {date: "2026-12-25", closed: true}, // clinic-wide
      {date: "2026-12-26", closed: false, staffId: "vet-a", windows: [{startMinute: 0, endMinute: 1440, capacity: 1}]},
    ]);

    const config = await loadAvailabilityConfig();
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0]?.startMinute).toBe(540);
    expect(config.exceptions).toHaveLength(1);
    expect(config.exceptions[0]?.date).toBe("2026-12-25");
  });
});

describe("listBookablePractitioners", () => {
  it("includes only vet/owner, bookable, non-disabled rows, sorted by staffId", async () => {
    const vetBookable = await Staff.create({email: "b@example.com", role: "vet", bookable: true});
    const ownerBookable = await Staff.create({email: "a@example.com", role: "owner", bookable: true});
    await Staff.create({email: "staffonly@example.com", role: "staff", bookable: true}); // wrong role
    await Staff.create({email: "notbookable@example.com", role: "vet", bookable: false}); // not bookable
    await Staff.create({email: "disabled@example.com", role: "vet", bookable: true, disabled: true}); // disabled

    const list = await listBookablePractitioners();
    const ids = list.map((p) => p.staffId).sort();
    expect(ids).toEqual([ownerBookable.staffId, vetBookable.staffId].sort());
    // Sorted by staffId ascending, deterministically.
    expect(list.map((p) => p.staffId)).toEqual([...list.map((p) => p.staffId)].sort());
  });

  it("falls back to the email local-part when displayName is unset", async () => {
    const vet = await Staff.create({email: "dr.rivera@example.com", role: "vet", bookable: true});
    const list = await listBookablePractitioners();
    expect(list.find((p) => p.staffId === vet.staffId)?.name).toBe("dr.rivera");
  });

  it("uses displayName when set", async () => {
    const vet = await Staff.create({email: "x@example.com", role: "vet", bookable: true, displayName: "Dr. Rivera"});
    const list = await listBookablePractitioners();
    expect(list.find((p) => p.staffId === vet.staffId)?.name).toBe("Dr. Rivera");
  });
});

describe("loadPractitionerRulesAndExceptions", () => {
  it("rules are staffId-matched only - no clinic-wide fallback", async () => {
    await AvailabilityRule.create([
      {dayOfWeek: 1, startMinute: 540, endMinute: 1020}, // clinic-wide - must NOT appear for vet-a
      {dayOfWeek: 1, startMinute: 600, endMinute: 900, staffId: "vet-a"},
    ]);
    const map = await loadPractitionerRulesAndExceptions(["vet-a"]);
    const own = map.get("vet-a");
    expect(own?.rules).toHaveLength(1);
    expect(own?.rules[0]?.startMinute).toBe(600);
  });

  it("exceptions include the practitioner's own PLUS clinic-wide ones, own listed first", async () => {
    await AvailabilityException.create([
      {date: "2026-12-25", closed: true}, // clinic-wide
      {date: "2026-11-01", closed: true, staffId: "vet-a"}, // own
    ]);
    const map = await loadPractitionerRulesAndExceptions(["vet-a"]);
    const exceptions = map.get("vet-a")?.exceptions ?? [];
    expect(exceptions.map((e) => e.date)).toEqual(["2026-11-01", "2026-12-25"]);
  });

  it("a practitioner's own exception for a date sorts before the clinic-wide one for the SAME date (first-match-wins order)", async () => {
    await AvailabilityException.create([
      {date: "2026-12-25", closed: true}, // clinic-wide: fully closed
      {date: "2026-12-25", closed: false, staffId: "vet-a", windows: [{startMinute: 600, endMinute: 900, capacity: 1}]}, // vet-a overrides: open
    ]);
    const map = await loadPractitionerRulesAndExceptions(["vet-a"]);
    const exceptions = map.get("vet-a")?.exceptions ?? [];
    // The FIRST entry for 2026-12-25 must be vet-a's own (open), not the clinic-wide closed one -
    // openWindowsForDate's `.find()` picks whichever comes first.
    const first = exceptions.find((e) => e.date === "2026-12-25");
    expect(first?.closed).toBe(false);
  });
});

describe("loadPractitionerOccupiedIntervals", () => {
  it("partitions correctly: own appointments + ALL unassigned, never another practitioner's assigned ones", async () => {
    const dayStart = Date.parse("2026-01-15T00:00:00-05:00") / 1000;
    const dayEnd = Date.parse("2026-01-16T00:00:00-05:00") / 1000;
    const ownAt = Date.parse("2026-01-15T09:00:00-05:00") / 1000;
    const unassignedAt = Date.parse("2026-01-15T10:00:00-05:00") / 1000;
    const otherAt = Date.parse("2026-01-15T11:00:00-05:00") / 1000;

    await Appointment.create([
      {
        clientName: "Own",
        petName: "Rex",
        startAt: ownAt,
        endAt: ownAt + 1800,
        source: "staff",
        practitionerStaffId: "vet-a",
      },
      {
        clientName: "Unassigned",
        petName: "Fido",
        startAt: unassignedAt,
        endAt: unassignedAt + 1800,
        source: "staff",
      },
      {
        clientName: "Other vet",
        petName: "Milo",
        startAt: otherAt,
        endAt: otherAt + 1800,
        source: "staff",
        practitionerStaffId: "vet-b",
      },
    ]);

    const map = await loadPractitionerOccupiedIntervals(dayStart, dayEnd, ["vet-a"]);
    const occupied = map.get("vet-a") ?? [];
    const starts = occupied.map((o) => o.start).sort();
    expect(starts).toEqual([ownAt, unassignedAt].sort());
    expect(starts).not.toContain(otherAt);
  });
});

describe("countPractitionerAppointmentsInRange", () => {
  it("counts only this practitioner's non-cancelled appointments within the range", async () => {
    const dayStart = Date.parse("2026-01-15T00:00:00-05:00") / 1000;
    const dayEnd = Date.parse("2026-01-16T00:00:00-05:00") / 1000;
    const at = (h: number) => Date.parse(`2026-01-15T${String(h).padStart(2, "0")}:00:00-05:00`) / 1000;

    await Appointment.create([
      {clientName: "A", petName: "P1", startAt: at(9), endAt: at(9) + 1800, source: "staff", practitionerStaffId: "vet-a"},
      {clientName: "B", petName: "P2", startAt: at(10), endAt: at(10) + 1800, source: "staff", practitionerStaffId: "vet-a"},
      {
        clientName: "C",
        petName: "P3",
        startAt: at(11),
        endAt: at(11) + 1800,
        source: "staff",
        practitionerStaffId: "vet-a",
        status: "cancelled",
      },
      {clientName: "D", petName: "P4", startAt: at(12), endAt: at(12) + 1800, source: "staff", practitionerStaffId: "vet-b"},
    ]);

    expect(await countPractitionerAppointmentsInRange("vet-a", dayStart, dayEnd)).toBe(2);
    expect(await countPractitionerAppointmentsInRange("vet-b", dayStart, dayEnd)).toBe(1);
  });
});
