import {describe, expect, it} from "vitest";
import {computePractitionerAvailability} from "@/lib/booking/availability";
import type {AvailabilityRuleLike, BookingSettingsLike, ServiceForAvailability} from "@/lib/booking/types";

/**
 * WP4.7 A4: `computePractitionerAvailability` - the per-practitioner counterpart of
 * `computeAvailability` (which stays completely untouched by this WP; see availability.test.ts,
 * unmodified, for the clinic-mode byte-parity proof). Same fixture conventions as
 * availability.test.ts (America/New_York, 2026-01-15 is a Thursday) so the two suites read
 * consistently.
 */
const NY = "America/New_York";

const settings: BookingSettingsLike = {
  timezone: NY,
  minNoticeMinutes: 0,
  maxAdvanceDays: 60,
  slotGranularityMinutes: 30,
};

const service: ServiceForAvailability = {durationMinutes: 30, bufferBeforeMin: 0, bufferAfterMin: 0};
const baseNow = Date.parse("2026-01-01T00:00:00-05:00") / 1000;

const dayRangeUtc = {
  fromUtc: Date.parse("2026-01-15T00:00:00-05:00") / 1000,
  toUtc: Date.parse("2026-01-16T00:00:00-05:00") / 1000,
};

const nineAm = Date.parse("2026-01-15T09:00:00-05:00") / 1000;
const nineThirty = Date.parse("2026-01-15T09:30:00-05:00") / 1000;
const tenAm = Date.parse("2026-01-15T10:00:00-05:00") / 1000;

function ruleFor(startHour: number, endHour: number, capacity = 1): AvailabilityRuleLike {
  return {dayOfWeek: 4, startMinute: startHour * 60, endMinute: endHour * 60, capacity}; // Thursday
}

describe("computePractitionerAvailability - union across practitioners", () => {
  it("a slot only one practitioner is free at reports just that practitioner", () => {
    const slots = computePractitionerAvailability({
      service,
      settings,
      practitioners: [
        {staffId: "vet-a", rules: [ruleFor(9, 12)], exceptions: [], occupied: []},
        {staffId: "vet-b", rules: [ruleFor(13, 17)], exceptions: [], occupied: []},
      ],
      ...dayRangeUtc,
      now: baseNow,
    });
    const nine = slots.find((s) => s.startAt === nineAm);
    expect(nine?.practitionerIds).toEqual(["vet-a"]);
  });

  it("a slot both practitioners are free at reports both, sorted", () => {
    const slots = computePractitionerAvailability({
      service,
      settings,
      practitioners: [
        {staffId: "vet-b", rules: [ruleFor(9, 17)], exceptions: [], occupied: []},
        {staffId: "vet-a", rules: [ruleFor(9, 17)], exceptions: [], occupied: []},
      ],
      ...dayRangeUtc,
      now: baseNow,
    });
    const nine = slots.find((s) => s.startAt === nineAm);
    expect(nine?.practitionerIds).toEqual(["vet-a", "vet-b"]);
  });

  it("a slot with zero free practitioners is absent from the result entirely - not present with an empty array", () => {
    const slots = computePractitionerAvailability({
      service,
      settings,
      // A 30-minute window (9:00-9:30) with a 30-minute service yields exactly ONE candidate
      // slot (9:00) - 9:30 itself is outside anyone's hours entirely.
      practitioners: [{staffId: "vet-a", rules: [{dayOfWeek: 4, startMinute: 9 * 60, endMinute: 9 * 60 + 30, capacity: 1}], exceptions: [], occupied: []}],
      ...dayRangeUtc,
      now: baseNow,
    });
    expect(slots.find((s) => s.startAt === nineAm)).toBeDefined();
    expect(slots.find((s) => s.startAt === nineThirty)).toBeUndefined();
  });

  it("no bookable practitioners at all yields an empty slot list", () => {
    const slots = computePractitionerAvailability({service, settings, practitioners: [], ...dayRangeUtc, now: baseNow});
    expect(slots).toEqual([]);
  });

  it("slots are sorted ascending by startAt", () => {
    const slots = computePractitionerAvailability({
      service,
      settings,
      practitioners: [{staffId: "vet-a", rules: [ruleFor(9, 11)], exceptions: [], occupied: []}],
      ...dayRangeUtc,
      now: baseNow,
    });
    const startTimes = slots.map((s) => s.startAt);
    expect(startTimes).toEqual([...startTimes].sort((a, b) => a - b));
  });
});

describe("computePractitionerAvailability - capacity forced to 1 (D2)", () => {
  it("a single overlapping appointment excludes the slot even when the stored rule capacity is greater than 1", () => {
    const slots = computePractitionerAvailability({
      service,
      settings,
      practitioners: [
        {
          staffId: "vet-a",
          rules: [ruleFor(9, 17, 5)], // capacity 5 on the stored rule - must be ignored
          exceptions: [],
          occupied: [{start: nineAm, end: nineAm + 30 * 60}],
        },
      ],
      ...dayRangeUtc,
      now: baseNow,
    });
    expect(slots.find((s) => s.startAt === nineAm)).toBeUndefined();
    expect(slots.find((s) => s.startAt === nineThirty)).toBeDefined();
  });

  it("a practitioner's exception window capacity is also forced to 1", () => {
    const slots = computePractitionerAvailability({
      service,
      settings,
      practitioners: [
        {
          staffId: "vet-a",
          rules: [ruleFor(9, 17)],
          exceptions: [{date: "2026-01-15", closed: false, windows: [{startMinute: 10 * 60, endMinute: 11 * 60, capacity: 9}]}],
          occupied: [{start: tenAm, end: tenAm + 30 * 60}],
        },
      ],
      ...dayRangeUtc,
      now: baseNow,
    });
    expect(slots.find((s) => s.startAt === tenAm)).toBeUndefined();
  });
});

describe("computePractitionerAvailability - D3 unassigned blocks every practitioner", () => {
  it("an occupied interval present in EVERY practitioner's own occupied list (simulating an unassigned appointment) removes the slot for all of them", () => {
    // The caller (queries.ts) is responsible for folding every unassigned appointment into every
    // practitioner's own `occupied` - this test simulates that by giving BOTH practitioners the
    // identical occupied interval, and asserts the union correctly shows nobody free.
    const unassigned = [{start: nineAm, end: nineAm + 30 * 60}];
    const slots = computePractitionerAvailability({
      service,
      settings,
      practitioners: [
        {staffId: "vet-a", rules: [ruleFor(9, 17)], exceptions: [], occupied: unassigned},
        {staffId: "vet-b", rules: [ruleFor(9, 17)], exceptions: [], occupied: unassigned},
      ],
      ...dayRangeUtc,
      now: baseNow,
    });
    expect(slots.find((s) => s.startAt === nineAm)).toBeUndefined();
    // The OTHER slots (not blocked) still show both practitioners free.
    expect(slots.find((s) => s.startAt === nineThirty)?.practitionerIds).toEqual(["vet-a", "vet-b"]);
  });

  it("an appointment assigned to ONE practitioner only blocks that practitioner, not the other", () => {
    const slots = computePractitionerAvailability({
      service,
      settings,
      practitioners: [
        {staffId: "vet-a", rules: [ruleFor(9, 17)], exceptions: [], occupied: [{start: nineAm, end: nineAm + 30 * 60}]},
        {staffId: "vet-b", rules: [ruleFor(9, 17)], exceptions: [], occupied: []},
      ],
      ...dayRangeUtc,
      now: baseNow,
    });
    expect(slots.find((s) => s.startAt === nineAm)?.practitionerIds).toEqual(["vet-b"]);
  });
});

describe("computePractitionerAvailability - per-practitioner rules/exceptions are independent", () => {
  it("a closed exception for one practitioner does not affect another practitioner's availability that day", () => {
    const slots = computePractitionerAvailability({
      service,
      settings,
      practitioners: [
        {staffId: "vet-a", rules: [ruleFor(9, 17)], exceptions: [{date: "2026-01-15", closed: true}], occupied: []},
        {staffId: "vet-b", rules: [ruleFor(9, 17)], exceptions: [], occupied: []},
      ],
      ...dayRangeUtc,
      now: baseNow,
    });
    expect(slots.find((s) => s.startAt === nineAm)?.practitionerIds).toEqual(["vet-b"]);
  });
});
