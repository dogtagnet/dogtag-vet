import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.7 A4 - the heart of this WP: `createAppointment`'s practitioner-mode dispatch (a named
 * practitioner, an unassigned staff booking, and D5's deterministic auto-assign), plus
 * cancellation correctly releasing exactly what was claimed. Everything here needs a real mongod
 * (`createAppointment` reads Service/Staff/BookingSettings/AvailabilityRule/AvailabilityException/
 * Appointment directly) - the pure per-slot math is already covered by
 * `practitionerAvailability.test.ts` and `buckets.test.ts`; this file is about the STATEFUL
 * chokepoint those pure pieces feed into.
 *
 * ISOLATION: own ephemeral mongod, port 44120 (44117/44118/44119 already taken by sibling suites).
 */
import {connectToDatabase} from "@/lib/db";
import {createAppointment, setAppointmentTerminalStatus} from "@/lib/booking/lifecycle";
import {Appointment} from "@/lib/models/Appointment";
import {AvailabilityException, AvailabilityRule, BookingSettings} from "@/lib/models/Availability";
import {Staff} from "@/lib/models/Staff";
import type {AppointmentDraft} from "@/lib/booking/mongoStore";

const MONGO_PORT = 44_120;

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-wp47-lifecycle-practitioner");
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
    Appointment.deleteMany({}),
    AvailabilityRule.deleteMany({}),
    AvailabilityException.deleteMany({}),
    BookingSettings.deleteMany({}),
    Staff.deleteMany({}),
  ]);
});

async function setPractitionerMode(): Promise<void> {
  await BookingSettings.findByIdAndUpdate(
    "singleton",
    {$set: {schedulingMode: "practitioner", timezone: "America/New_York", minNoticeMinutes: 0, maxAdvanceDays: 60, slotGranularityMinutes: 30}},
    {upsert: true},
  );
}

function draftAt(overrides: Partial<AppointmentDraft> & {startAt: number; endAt: number}): AppointmentDraft {
  return {
    clientName: "Test Client",
    petName: "Test Pet",
    source: "public_booking",
    ...overrides,
  };
}

// Thursday 2026-01-15, 9am-5pm ET in both fixtures below unless noted.
const thu9am = Date.parse("2026-01-15T09:00:00-05:00") / 1000;
const thu10am = Date.parse("2026-01-15T10:00:00-05:00") / 1000;
const THURSDAY = 4;

describe("createAppointment - clinic mode is unaffected", () => {
  it("still enforces hours/capacity exactly as before when schedulingMode is clinic (the default)", async () => {
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, capacity: 1});
    const draft = draftAt({startAt: thu9am, endAt: thu9am + 1800});
    const ok = await createAppointment(draft, {enforceCapacity: true});
    expect(ok.ok).toBe(true);

    const conflict = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800}), {enforceCapacity: true});
    expect(conflict).toEqual({ok: false, reason: "slot_conflict"});

    const outside = await createAppointment(draftAt({startAt: thu9am + 10 * 3600, endAt: thu9am + 10 * 3600 + 1800}), {
      enforceCapacity: true,
    });
    expect(outside).toEqual({ok: false, reason: "outside_hours"});
  });
});

describe("createAppointment - practitioner mode, named practitioner", () => {
  it("books successfully within the NAMED practitioner's own hours", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "a@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});

    const result = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.appointment.practitionerStaffId).toBe(vetA.staffId);
      expect(result.appointment.bucketScope).toEqual([vetA.staffId]);
    }
  });

  it("REJECTS a time that is only within a DIFFERENT practitioner's hours (the exact bug the engine rework fixes)", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "a@example.com", role: "vet", bookable: true});
    const vetB = await Staff.create({email: "b@example.com", role: "vet", bookable: true});
    // vet-a works mornings only; vet-b works afternoons only.
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 12 * 60, staffId: vetA.staffId});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 13 * 60, endMinute: 17 * 60, staffId: vetB.staffId});

    // 9am is within vet-b's stored rule set (via loadAvailabilityConfig if this were buggy) but
    // NOT within vet-a's own hours - booking vet-a at 9am must fail even though a rule for 9am
    // exists SOMEWHERE in the AvailabilityRule collection.
    const result = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetB.staffId}), {
      enforceCapacity: true,
    });
    expect(result).toEqual({ok: false, reason: "outside_hours"});
  });

  it("D2: capacity is intrinsically 1 for a practitioner, even if the stored rule capacity is greater than 1", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "a@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, capacity: 5, staffId: vetA.staffId});

    const first = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(first.ok).toBe(true);

    const second = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(second).toEqual({ok: false, reason: "slot_conflict"});
  });

  it("rejects an unknown or non-bookable practitionerId with invalid_practitioner", async () => {
    await setPractitionerMode();
    const notBookable = await Staff.create({email: "nb@example.com", role: "vet", bookable: false});

    const unknown = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: "does-not-exist"}), {
      enforceCapacity: true,
    });
    expect(unknown).toEqual({ok: false, reason: "invalid_practitioner"});

    const notBookableResult = await createAppointment(
      draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: notBookable.staffId}),
      {enforceCapacity: true},
    );
    expect(notBookableResult).toEqual({ok: false, reason: "invalid_practitioner"});
  });

  it("a staff booking (enforceCapacity: false) for a named practitioner still validates the practitioner exists and is bookable, but skips the hours check", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "a@example.com", role: "vet", bookable: true});
    // No rules configured at all for vet-a - a staff walk-in can still book them (matches
    // clinic mode's existing "staff can double-book/override hours deliberately" behavior).
    const result = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: false,
    });
    expect(result.ok).toBe(true);
  });
});

describe("createAppointment - D3 unassigned blocks ALL practitioners", () => {
  it("a staff-created unassigned appointment blocks every currently bookable practitioner from an enforced-capacity booking at the same time", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "a@example.com", role: "vet", bookable: true});
    const vetB = await Staff.create({email: "b@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetB.staffId});

    const unassigned = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, source: "staff"}), {
      enforceCapacity: false,
    });
    expect(unassigned.ok).toBe(true);
    if (unassigned.ok) {
      expect(unassigned.appointment.practitionerStaffId).toBeUndefined();
      expect(unassigned.appointment.bucketScope?.sort()).toEqual([vetA.staffId, vetB.staffId].sort());
    }

    const blockedA = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(blockedA).toEqual({ok: false, reason: "slot_conflict"});
    const blockedB = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetB.staffId}), {
      enforceCapacity: true,
    });
    expect(blockedB).toEqual({ok: false, reason: "slot_conflict"});
  });
});

describe("createAppointment - D5 deterministic auto-assign", () => {
  it("assigns to the practitioner with fewer appointments that day when both are free", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "a@example.com", role: "vet", bookable: true});
    const vetB = await Staff.create({email: "b@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetB.staffId});

    // Give vet-a one appointment earlier that day so vet-b (fewer appointments) should win.
    const earlier = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(earlier.ok).toBe(true);

    const autoAssigned = await createAppointment(draftAt({startAt: thu10am, endAt: thu10am + 1800}), {enforceCapacity: true});
    expect(autoAssigned.ok).toBe(true);
    if (autoAssigned.ok) expect(autoAssigned.appointment.practitionerStaffId).toBe(vetB.staffId);
  });

  it("ties break by staffId ascending", async () => {
    await setPractitionerMode();
    const vets = await Promise.all(
      ["z@example.com", "a@example.com"].map((email) => Staff.create({email, role: "vet", bookable: true})),
    );
    const [vetZ, vetA] = vets.sort((x, y) => (x.email < y.email ? 1 : -1)); // vetZ.email "z@...", vetA.email "a@..."
    for (const vet of vets) {
      await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vet!.staffId});
    }
    const winner = [vetZ!.staffId, vetA!.staffId].sort()[0];

    const result = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800}), {enforceCapacity: true});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.appointment.practitionerStaffId).toBe(winner);
  });

  it("retries the next candidate when the first (by sort order) is already busy", async () => {
    await setPractitionerMode();
    const staff = await Promise.all(
      ["a@example.com", "b@example.com"].map((email) => Staff.create({email, role: "vet", bookable: true})),
    );
    const sorted = [...staff].sort((x, y) => x.staffId.localeCompare(y.staffId));
    const first = sorted[0]!;
    const second = sorted[1]!;
    for (const vet of staff) {
      await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vet.staffId});
    }
    // Book the FIRST candidate directly, occupying the slot - auto-assign must fall through to
    // the second.
    const direct = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: first.staffId}), {
      enforceCapacity: true,
    });
    expect(direct.ok).toBe(true);

    const autoAssigned = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800}), {enforceCapacity: true});
    expect(autoAssigned.ok).toBe(true);
    if (autoAssigned.ok) expect(autoAssigned.appointment.practitionerStaffId).toBe(second.staffId);
  });

  it("returns slot_conflict (409-equivalent) when every bookable practitioner is busy or has no matching hours", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "a@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});
    const booked = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(booked.ok).toBe(true);

    const autoAssigned = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800}), {enforceCapacity: true});
    expect(autoAssigned).toEqual({ok: false, reason: "slot_conflict"});
  });

  it("returns slot_conflict when there are zero bookable practitioners at all", async () => {
    await setPractitionerMode();
    const result = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800}), {enforceCapacity: true});
    expect(result).toEqual({ok: false, reason: "slot_conflict"});
  });
});

describe("setAppointmentTerminalStatus - cancellation releases exactly what was claimed", () => {
  it("cancelling a named-practitioner appointment frees that SAME practitioner's slot for re-booking", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "a@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});

    const booked = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;

    const stillConflicts = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(stillConflicts).toEqual({ok: false, reason: "slot_conflict"});

    await setAppointmentTerminalStatus(booked.appointment.appointmentId, "cancelled");

    const rebooked = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(rebooked.ok).toBe(true);
  });

  it("cancelling an unassigned appointment frees every practitioner it had blocked", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "a@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});

    const unassigned = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, source: "staff"}), {
      enforceCapacity: false,
    });
    expect(unassigned.ok).toBe(true);
    if (!unassigned.ok) return;

    const blocked = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(blocked).toEqual({ok: false, reason: "slot_conflict"});

    await setAppointmentTerminalStatus(unassigned.appointment.appointmentId, "cancelled");

    const nowFree = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(nowFree.ok).toBe(true);
  });
});
