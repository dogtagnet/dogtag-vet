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
import {createAppointment, reassignPractitioner, setAppointmentTerminalStatus} from "@/lib/booking/lifecycle";
import {loadPractitionerOccupiedIntervals} from "@/lib/booking/queries";
import {Appointment} from "@/lib/models/Appointment";
import {AvailabilityException, AvailabilityRule, BookingSettings} from "@/lib/models/Availability";
import {CapacityBucket} from "@/lib/models/CapacityBucket";
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
    // WP4.7A FIX ROUND 1: pre-existing test-isolation gap, found while adding the D3 mode-switch
    // regression test below. Every OTHER test in this file claims practitioner-scoped `p:<staffId>:`
    // bucket keys with a fresh randomUUID() staffId each time (Staff.create()), so residual
    // CapacityBucket counts never collided across tests by accident - but a PLAIN clinic-mode key
    // (no staffId prefix) is the SAME literal key every time thu9am/thu10am is reused, and this
    // file never released what "clinic mode is unaffected" (the very first test below) claims.
    // Cleaning the ledger here, like every other collection, is what test isolation actually
    // requires - nothing in this file relies on bucket state surviving across a test boundary.
    CapacityBucket.deleteMany({}),
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

describe("reassignPractitioner - WP4.7 A6, claim-new-before-release-old", () => {
  it("reassigns A -> B when B is free: B's buckets claimed, A's released, both fields updated", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "a@example.com", role: "vet", bookable: true});
    const vetB = await Staff.create({email: "b@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetB.staffId});

    const booked = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;

    const reassigned = await reassignPractitioner(booked.appointment.appointmentId, vetB.staffId);
    expect(reassigned.ok).toBe(true);
    if (reassigned.ok) {
      expect(reassigned.appointment.practitionerStaffId).toBe(vetB.staffId);
      expect(reassigned.appointment.bucketScope).toEqual([vetB.staffId]);
    }

    // B's slot is now taken - a second booking for B at the same time must conflict.
    const bBusy = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetB.staffId}), {
      enforceCapacity: true,
    });
    expect(bBusy).toEqual({ok: false, reason: "slot_conflict"});

    // A's slot was released - a fresh booking for A at the same time must now succeed.
    const aFree = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(aFree.ok).toBe(true);
  });

  it("refuses A -> B when B is already booked at that time, and leaves the appointment on A with A's buckets still claimed", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "a@example.com", role: "vet", bookable: true});
    const vetB = await Staff.create({email: "b@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetB.staffId});

    const bookedA = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(bookedA.ok).toBe(true);
    if (!bookedA.ok) return;
    const bookedB = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetB.staffId}), {
      enforceCapacity: true,
    });
    expect(bookedB.ok).toBe(true);

    const reassigned = await reassignPractitioner(bookedA.appointment.appointmentId, vetB.staffId);
    expect(reassigned).toEqual({ok: false, reason: "slot_conflict"});

    // The appointment must be COMPLETELY unchanged - still on A, still holding A's own bucket.
    const stillA = await Appointment.findOne({appointmentId: bookedA.appointment.appointmentId}).lean();
    expect(stillA?.practitionerStaffId).toBe(vetA.staffId);
    expect(stillA?.bucketScope).toEqual([vetA.staffId]);

    // A's slot must STILL be claimed (the failed reassignment must not have released it) - a fresh
    // attempt to double-book A at this exact time must still conflict.
    const aStillBusy = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(aStillBusy).toEqual({ok: false, reason: "slot_conflict"});
  });

  it("reassigns A -> unassigned (blocks every bookable practitioner) and unassigned -> A (narrows back to one)", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "a@example.com", role: "vet", bookable: true});
    const vetB = await Staff.create({email: "b@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetB.staffId});

    const booked = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;

    const toUnassigned = await reassignPractitioner(booked.appointment.appointmentId, null);
    expect(toUnassigned.ok).toBe(true);
    if (toUnassigned.ok) {
      expect(toUnassigned.appointment.practitionerStaffId).toBeUndefined();
      expect(toUnassigned.appointment.bucketScope?.sort()).toEqual([vetA.staffId, vetB.staffId].sort());
    }

    // Unassigned now blocks BOTH practitioners, not just A.
    const bBlocked = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetB.staffId}), {
      enforceCapacity: true,
    });
    expect(bBlocked).toEqual({ok: false, reason: "slot_conflict"});

    const backToA = await reassignPractitioner(booked.appointment.appointmentId, vetA.staffId);
    expect(backToA.ok).toBe(true);
    if (backToA.ok) expect(backToA.appointment.bucketScope).toEqual([vetA.staffId]);

    // Narrowed back to just A - B must now be free.
    const bNowFree = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetB.staffId}), {
      enforceCapacity: true,
    });
    expect(bNowFree.ok).toBe(true);
  });

  it("refuses reassignment to a practitioner whose hours don't cover the existing time, leaving the appointment unchanged", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "a@example.com", role: "vet", bookable: true});
    const vetB = await Staff.create({email: "b@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});
    // vet-b works afternoons only - does not cover thu9am at all.
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 13 * 60, endMinute: 17 * 60, staffId: vetB.staffId});

    const booked = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;

    const reassigned = await reassignPractitioner(booked.appointment.appointmentId, vetB.staffId);
    expect(reassigned).toEqual({ok: false, reason: "outside_hours"});

    const stillA = await Appointment.findOne({appointmentId: booked.appointment.appointmentId}).lean();
    expect(stillA?.practitionerStaffId).toBe(vetA.staffId);
    expect(stillA?.bucketScope).toEqual([vetA.staffId]);
  });

  it("rejects reassignment to an unknown or non-bookable practitioner, leaving the appointment unchanged", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "a@example.com", role: "vet", bookable: true});
    const notBookable = await Staff.create({email: "nb@example.com", role: "vet", bookable: false});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});

    const booked = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;

    const toUnknown = await reassignPractitioner(booked.appointment.appointmentId, "does-not-exist");
    expect(toUnknown).toEqual({ok: false, reason: "invalid_practitioner"});
    const toNotBookable = await reassignPractitioner(booked.appointment.appointmentId, notBookable.staffId);
    expect(toNotBookable).toEqual({ok: false, reason: "invalid_practitioner"});

    const stillA = await Appointment.findOne({appointmentId: booked.appointment.appointmentId}).lean();
    expect(stillA?.practitionerStaffId).toBe(vetA.staffId);
  });

  it("a no-op reassignment (same practitioner) succeeds without touching any bucket", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "a@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});

    const booked = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;

    const noop = await reassignPractitioner(booked.appointment.appointmentId, vetA.staffId);
    expect(noop).toEqual({ok: true, appointment: booked.appointment});

    // Still exactly one claim on A's slot - a second booking still conflicts, not two independent
    // over-claims from a buggy release+reclaim on a no-op.
    const stillBusy = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(stillBusy).toEqual({ok: false, reason: "slot_conflict"});
  });

  it("reassigning a CANCELLED appointment's practitioner is a plain field update - no bucket claim, since a terminal appointment already released its buckets", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "a@example.com", role: "vet", bookable: true});
    const vetB = await Staff.create({email: "b@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetB.staffId});

    const booked = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;
    await setAppointmentTerminalStatus(booked.appointment.appointmentId, "cancelled");

    const reassigned = await reassignPractitioner(booked.appointment.appointmentId, vetB.staffId);
    expect(reassigned.ok).toBe(true);
    if (reassigned.ok) expect(reassigned.appointment.practitionerStaffId).toBe(vetB.staffId);

    // B must NOT have had a bucket claimed by this - B's slot at this exact time is still free.
    const bFree = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetB.staffId}), {
      enforceCapacity: true,
    });
    expect(bFree.ok).toBe(true);
  });
});

/**
 * WP4.7A FIX ROUND 1 (MAJOR-1, grade round 1) - grade.md's own reproductions, pinned permanently.
 * The bucket ledger is authoritative only WITHIN the roster/mode it was claimed under; it is not a
 * live query, so an appointment lacking a matching `p:<staffId>:` claim was previously invisible to
 * the NAMED write path (`createAppointment`'s named branch, `reassignPractitioner`) while remaining
 * correctly blocking on every READ path (`loadPractitionerOccupiedIntervals`, used by availability
 * computation and by `autoAssignAndCreate`). Each case below pairs the breach assertion with a
 * control that was ALREADY correct before this fix, isolating the defect to exactly the branch the
 * grade file named.
 */
describe("D3 across a mode switch / roster change", () => {
  it("clinic -> practitioner mode switch: a pre-switch clinic booking blocks a same-slot NAMED practitioner booking (auto-assign control stays correct throughout)", async () => {
    // An ORDINARY public/clinic booking, not a seeded row - clinic mode never sets
    // practitionerStaffId, so this appointment carries plain (non-practitioner-scoped) bucket keys.
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60});
    const legacy = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800}), {enforceCapacity: true});
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(legacy.appointment.practitionerStaffId).toBeUndefined();
    expect(legacy.appointment.bucketScope).toBeUndefined();

    // The operator follows DEPLOY.md: a practitioner is made bookable with their own hours, then
    // the clinic switches modes. The legacy appointment above is now "Unassigned" and, per D3,
    // must block every currently bookable practitioner at its exact instant.
    const vetA = await Staff.create({email: "modeswitch-a@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});
    await setPractitionerMode();

    // CONTROL (already correct pre-fix): the read path's own auto-assign, with no requested
    // practitioner, correctly refuses - proving the occupancy READ was never the problem.
    const autoAssignControl = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800}), {enforceCapacity: true});
    expect(autoAssignControl).toEqual({ok: false, reason: "slot_conflict"});

    // BREACH (grade round 1): the SAME instant, naming vetA explicitly, must ALSO refuse - this is
    // the wire field WP4.7 added (`practitionerId`), and it must fail closed exactly like the
    // control above.
    const namedBreach = await createAppointment(
      draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}),
      {enforceCapacity: true},
    );
    expect(namedBreach).toEqual({ok: false, reason: "slot_conflict"});
  });

  it("roster growth: a practitioner added AFTER an unassigned appointment already exists is still blocked by it for a NAMED booking (bucket-mechanism control stays correct for the ORIGINAL roster member)", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "roster-a@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});

    // Staff-created, deliberately unassigned - bucketScope snapshots ONLY who was bookable right
    // now (vetA alone), per AppointmentDoc.bucketScope's own doc comment.
    const blocker = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, source: "staff"}), {
      enforceCapacity: false,
    });
    expect(blocker.ok).toBe(true);
    if (blocker.ok) expect(blocker.appointment.bucketScope).toEqual([vetA.staffId]);

    // Roster growth AFTER the blocker was created - vetC's own `p:vetC:` bucket space was never
    // touched by it.
    const vetC = await Staff.create({email: "roster-c@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetC.staffId});

    // CONTROL (already correct pre-fix, via the pre-existing bucket claim - not the new occupancy
    // read): vetA, who WAS in the blocker's snapshot, is still correctly refused.
    const originalMemberControl = await createAppointment(
      draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}),
      {enforceCapacity: true},
    );
    expect(originalMemberControl).toEqual({ok: false, reason: "slot_conflict"});

    // BREACH (grade round 1): vetC, added after the blocker existed, must ALSO be refused - D3
    // blocks every CURRENTLY bookable practitioner, not only whoever was bookable at creation time.
    const rosterGrowthBreach = await createAppointment(
      draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetC.staffId}),
      {enforceCapacity: true},
    );
    expect(rosterGrowthBreach).toEqual({ok: false, reason: "slot_conflict"});
  });

  it("reassignment onto a practitioner added AFTER an unassigned appointment is refused (read-path control proves the occupancy READ was already correct - only the WRITE path needed the fix)", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "reassign-a@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});

    // An appointment that will later be reassigned - currently on vetA, at the slot the blocker
    // (below) will also occupy. Staff can deliberately double-book (enforceCapacity: false), so
    // creating the unassigned blocker on top of this does not fail.
    const toMove = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, practitionerStaffId: vetA.staffId}), {
      enforceCapacity: true,
    });
    expect(toMove.ok).toBe(true);
    if (!toMove.ok) return;

    const blocker = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, source: "staff"}), {
      enforceCapacity: false,
    });
    expect(blocker.ok).toBe(true);
    if (blocker.ok) expect(blocker.appointment.bucketScope).toEqual([vetA.staffId]); // only vetA bookable so far

    // Roster growth AFTER the blocker was created.
    const vetB = await Staff.create({email: "reassign-b@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetB.staffId});

    // CONTROL (already correct pre-fix and unaffected by this fix): the occupancy READ used by
    // availability computation already reports vetB as occupied at this instant because of the
    // unassigned blocker - "D3 is enforced on the read path only" is precisely this fact.
    const readPathControl = await loadPractitionerOccupiedIntervals(toMove.appointment.startAt, toMove.appointment.endAt, [
      vetB.staffId,
    ]);
    expect(readPathControl.get(vetB.staffId)?.length).toBeGreaterThan(0);

    // BREACH (grade round 1): reassigning `toMove` (currently on vetA, nothing to do with the
    // blocker) onto vetB must be refused - vetB is blocked by the unassigned blocker exactly like
    // the control above already knew, but only the WRITE path failed to consult it.
    const reassignBreach = await reassignPractitioner(toMove.appointment.appointmentId, vetB.staffId);
    expect(reassignBreach).toEqual({ok: false, reason: "slot_conflict"});

    // toMove must be COMPLETELY unchanged by the refused reassignment.
    const stillOnA = await Appointment.findOne({appointmentId: toMove.appointment.appointmentId}).lean();
    expect(stillOnA?.practitionerStaffId).toBe(vetA.staffId);
    expect(stillOnA?.bucketScope).toEqual([vetA.staffId]);
  });

  /**
   * Advisor-flagged consequence of this fix round, verified empirically before writing it up in
   * docs/DEPLOY.md: two unassigned appointments can legitimately land at the EXACT same instant
   * (a Whole-clinic window with capacity > 1 before the mode switch), and with the fix in place,
   * NEITHER can be reassigned to the sole practitioner while the other still sits unassigned - each
   * one, from the other's perspective, is itself an "unassigned appointment" D3 folds into every
   * staffId's occupancy. Pre-fix this pair was NOT correctly handled either: whichever reassignment
   * happened to be attempted first silently won via the same stale-bucket gap MAJOR-1 closes,
   * arbitrarily and without the operator ever deciding who should get the one available slot. This
   * test pins the new, safe behavior - refuse both until a human resolves the actual conflict - as
   * permanent and intentional, not a regression to relax later.
   */
  it("two unassigned appointments at the identical instant: neither can be assigned while the other remains unassigned; resolving one (cancelling it) frees the other", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "overlap-a@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});

    // Two staff-created unassigned appointments at the SAME instant - modelling a legacy
    // Whole-clinic window that once had capacity 2 (or two direct staff bookings), now both
    // "Unassigned" after the mode switch.
    const apptA = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, source: "staff"}), {
      enforceCapacity: false,
    });
    const apptB = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, source: "staff"}), {
      enforceCapacity: false,
    });
    expect(apptA.ok).toBe(true);
    expect(apptB.ok).toBe(true);
    if (!apptA.ok || !apptB.ok) return;

    // BOTH refuse - the OTHER one, still unassigned, blocks vetA exactly as D3 says any unassigned
    // appointment must.
    const assignA = await reassignPractitioner(apptA.appointment.appointmentId, vetA.staffId);
    expect(assignA).toEqual({ok: false, reason: "slot_conflict"});
    const assignB = await reassignPractitioner(apptB.appointment.appointmentId, vetA.staffId);
    expect(assignB).toEqual({ok: false, reason: "slot_conflict"});

    // The operator resolves the genuine conflict a human must decide (cancelling one - an
    // appointment's time cannot be edited after creation) - once B is no longer live, A can be
    // assigned normally.
    await setAppointmentTerminalStatus(apptB.appointment.appointmentId, "cancelled");
    const assignAAfter = await reassignPractitioner(apptA.appointment.appointmentId, vetA.staffId);
    expect(assignAAfter.ok).toBe(true);
    if (assignAAfter.ok) expect(assignAAfter.appointment.practitionerStaffId).toBe(vetA.staffId);
  });

  /**
   * Grade round 2, N1's pinning assertion: DEPLOY.md's same-instant paragraph must never again
   * suggest "add a second bookable practitioner" as a remedy - it does not work BY CONSTRUCTION
   * (each unassigned appointment folds into EVERY practitioner's occupancy, a newly added one
   * included), and this test is what makes the corrected sentence load-bearing rather than prose.
   */
  it("two unassigned appointments at the identical instant: adding a SECOND bookable practitioner does not clear the deadlock - both assignments still refuse", async () => {
    await setPractitionerMode();
    const vetA = await Staff.create({email: "overlap2-a@example.com", role: "vet", bookable: true});
    const vetB = await Staff.create({email: "overlap2-b@example.com", role: "vet", bookable: true});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetA.staffId});
    await AvailabilityRule.create({dayOfWeek: THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60, staffId: vetB.staffId});

    const apptA = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, source: "staff"}), {
      enforceCapacity: false,
    });
    const apptB = await createAppointment(draftAt({startAt: thu9am, endAt: thu9am + 1800, source: "staff"}), {
      enforceCapacity: false,
    });
    expect(apptA.ok).toBe(true);
    expect(apptB.ok).toBe(true);
    if (!apptA.ok || !apptB.ok) return;

    // One practitioner EACH would resolve a "real" double-booking - and is exactly what D3
    // refuses while both appointments are unassigned: each blocks every practitioner.
    const assignAtoA = await reassignPractitioner(apptA.appointment.appointmentId, vetA.staffId);
    expect(assignAtoA).toEqual({ok: false, reason: "slot_conflict"});
    const assignBtoB = await reassignPractitioner(apptB.appointment.appointmentId, vetB.staffId);
    expect(assignBtoB).toEqual({ok: false, reason: "slot_conflict"});
  });
});
