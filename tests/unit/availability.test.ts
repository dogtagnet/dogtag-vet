import {describe, expect, it} from "vitest";
import {computeAvailability} from "@/lib/booking/availability";
import type {AvailabilityRuleLike, BookingSettingsLike, ServiceForAvailability} from "@/lib/booking/types";

const NY = "America/New_York";

const settings: BookingSettingsLike = {
  timezone: NY,
  minNoticeMinutes: 0,
  maxAdvanceDays: 60,
  slotGranularityMinutes: 30,
};

const weekdayRule: AvailabilityRuleLike = {dayOfWeek: 4, startMinute: 9 * 60, endMinute: 17 * 60, capacity: 1}; // Thursday 9-17

const service: ServiceForAvailability = {durationMinutes: 30, bufferBeforeMin: 0, bufferAfterMin: 0};

// Anchors "now" well before every fixture date below (2026-01 through 2026-03), inside the
// default 60-day maxAdvanceDays window, so tests that don't specifically exercise minNotice/
// maxAdvance aren't inadvertently tripped up by them.
const baseNow = Date.parse("2026-01-01T00:00:00-05:00") / 1000;

// 2026-01-15 is a Thursday; range covers the whole clinic-local day.
const dayRangeUtc = {
  fromUtc: Date.parse("2026-01-15T00:00:00-05:00") / 1000,
  toUtc: Date.parse("2026-01-16T00:00:00-05:00") / 1000,
};

describe("computeAvailability - weekly rules", () => {
  it("generates one slot per granularity step across the whole open window", () => {
    const slots = computeAvailability({
      service,
      rules: [weekdayRule],
      exceptions: [],
      settings,
      existingOccupied: [],
      ...dayRangeUtc,
      now: baseNow,
    });
    // 9:00-17:00 = 480 minutes; 30-minute service, 30-minute granularity, no buffers -> 16 slots.
    expect(slots).toHaveLength(16);
    expect(slots.at(0)?.startAt).toBe(Date.parse("2026-01-15T09:00:00-05:00") / 1000);
    expect(slots.at(0)?.endAt).toBe(Date.parse("2026-01-15T09:30:00-05:00") / 1000);
    expect(slots.at(-1)?.startAt).toBe(Date.parse("2026-01-15T16:30:00-05:00") / 1000);
  });

  it("produces no slots on a day with no matching rule", () => {
    // 2026-01-16 is a Friday; only the Thursday rule is configured.
    const slots = computeAvailability({
      service,
      rules: [weekdayRule],
      exceptions: [],
      settings,
      existingOccupied: [],
      fromUtc: Date.parse("2026-01-16T00:00:00-05:00") / 1000,
      toUtc: Date.parse("2026-01-17T00:00:00-05:00") / 1000,
      now: baseNow,
    });
    expect(slots).toHaveLength(0);
  });
});

describe("computeAvailability - exceptions", () => {
  it("a closed exception removes every slot regardless of the weekly rule", () => {
    const slots = computeAvailability({
      service,
      rules: [weekdayRule],
      exceptions: [{date: "2026-01-15", closed: true}],
      settings,
      existingOccupied: [],
      ...dayRangeUtc,
      now: baseNow,
    });
    expect(slots).toHaveLength(0);
  });

  it("a windows exception replaces the weekly rule entirely for that date", () => {
    const slots = computeAvailability({
      service,
      rules: [weekdayRule],
      exceptions: [
        {date: "2026-01-15", closed: false, windows: [{startMinute: 10 * 60, endMinute: 11 * 60, capacity: 2}]},
      ],
      settings,
      existingOccupied: [],
      ...dayRangeUtc,
      now: baseNow,
    });
    // 10:00-11:00 = 60 minutes / 30-minute slots -> 2 slots, each with capacity 2.
    expect(slots).toHaveLength(2);
    expect(slots.every((s) => s.capacity === 2)).toBe(true);
    expect(slots.at(0)?.startAt).toBe(Date.parse("2026-01-15T10:00:00-05:00") / 1000);
  });
});

describe("computeAvailability - buffers", () => {
  it("shrinks the offerable range so the buffered footprint stays inside the window", () => {
    const buffered: ServiceForAvailability = {durationMinutes: 30, bufferBeforeMin: 15, bufferAfterMin: 15};
    const slots = computeAvailability({
      service: buffered,
      rules: [weekdayRule],
      exceptions: [],
      settings,
      existingOccupied: [],
      ...dayRangeUtc,
      now: baseNow,
    });
    // Candidate starts are still on the 30-minute grid anchored at the window's own start (9:00,
    // 9:30, ...) - buffering only filters candidates out, it doesn't shift the grid to find a
    // tighter fit. 9:00 doesn't fit (its occupied start, 8:45, falls before the window opens), so
    // the first offered start is 9:30; the last is 16:00 (16:30's occupied end, 16:45, still fits,
    // but 17:00's would not, and the grid never reaches an in-between value that would).
    expect(slots.at(0)?.startAt).toBe(Date.parse("2026-01-15T09:30:00-05:00") / 1000);
    expect(slots.at(-1)?.startAt).toBe(Date.parse("2026-01-15T16:00:00-05:00") / 1000);
    for (const slot of slots) {
      const occupiedStart = slot.startAt - 15 * 60;
      const occupiedEnd = slot.endAt + 15 * 60;
      expect(occupiedStart).toBeGreaterThanOrEqual(Date.parse("2026-01-15T09:00:00-05:00") / 1000);
      expect(occupiedEnd).toBeLessThanOrEqual(Date.parse("2026-01-15T17:00:00-05:00") / 1000);
    }
  });
});

describe("computeAvailability - capacity and existing appointments", () => {
  it("excludes a slot once overlapping non-cancelled appointments reach capacity", () => {
    const capacityTwoRule: AvailabilityRuleLike = {...weekdayRule, capacity: 2};
    const nineAm = Date.parse("2026-01-15T09:00:00-05:00") / 1000;
    const slots = computeAvailability({
      service,
      rules: [capacityTwoRule],
      exceptions: [],
      settings,
      existingOccupied: [
        {start: nineAm, end: nineAm + 30 * 60},
        {start: nineAm, end: nineAm + 30 * 60},
      ],
      ...dayRangeUtc,
      now: baseNow,
    });
    expect(slots.find((s) => s.startAt === nineAm)).toBeUndefined();
    // The next slot (9:30) is untouched.
    expect(slots.find((s) => s.startAt === nineAm + 30 * 60)).toBeDefined();
  });

  it("reports the remaining capacity, not just a boolean", () => {
    const capacityTwoRule: AvailabilityRuleLike = {...weekdayRule, capacity: 2};
    const nineAm = Date.parse("2026-01-15T09:00:00-05:00") / 1000;
    const slots = computeAvailability({
      service,
      rules: [capacityTwoRule],
      exceptions: [],
      settings,
      existingOccupied: [{start: nineAm, end: nineAm + 30 * 60}],
      ...dayRangeUtc,
      now: baseNow,
    });
    expect(slots.find((s) => s.startAt === nineAm)?.capacity).toBe(1);
  });

  it("counts an existing appointment's buffer against a candidate slot's own window even without overlapping raw times", () => {
    // Existing appointment occupies (with its buffer already applied by the caller) 8:45-9:15;
    // a candidate slot at 9:00-9:30 must see this as a conflict even though the two RAW spans
    // only partially overlap - the caller is responsible for buffering both sides consistently.
    const nineAm = Date.parse("2026-01-15T09:00:00-05:00") / 1000;
    const slots = computeAvailability({
      service,
      rules: [weekdayRule],
      exceptions: [],
      settings,
      existingOccupied: [{start: nineAm - 15 * 60, end: nineAm + 15 * 60}],
      ...dayRangeUtc,
      now: baseNow,
    });
    expect(slots.find((s) => s.startAt === nineAm)).toBeUndefined();
  });
});

describe("computeAvailability - minNotice and maxAdvance", () => {
  it("excludes slots that start before now + minNoticeMinutes", () => {
    const nineAm = Date.parse("2026-01-15T09:00:00-05:00") / 1000;
    const slots = computeAvailability({
      service,
      rules: [weekdayRule],
      exceptions: [],
      settings: {...settings, minNoticeMinutes: 90},
      existingOccupied: [],
      ...dayRangeUtc,
      now: nineAm, // now == 9:00, so anything before 10:30 is inside the notice window
    });
    expect(slots.every((s) => s.startAt >= nineAm + 90 * 60)).toBe(true);
    expect(slots.find((s) => s.startAt === nineAm)).toBeUndefined();
  });

  it("excludes slots that start after now + maxAdvanceDays", () => {
    const slots = computeAvailability({
      service,
      rules: [weekdayRule],
      exceptions: [],
      settings: {...settings, maxAdvanceDays: 1},
      existingOccupied: [],
      fromUtc: Date.parse("2026-01-15T00:00:00-05:00") / 1000,
      toUtc: Date.parse("2026-02-01T00:00:00-05:00") / 1000,
      now: Date.parse("2026-01-01T00:00:00-05:00") / 1000,
    });
    const cutoff = Date.parse("2026-01-02T00:00:00-05:00") / 1000;
    expect(slots.every((s) => s.startAt <= cutoff)).toBe(true);
    expect(slots.length).toBe(0); // 2026-01-15 is well past a 1-day advance window from Jan 1
  });
});

describe("computeAvailability - DST boundary (America/New_York, 2026-03-08 spring-forward)", () => {
  it("never offers a slot inside the nonexistent 2:00-3:00am local hour", () => {
    const earlyRule: AvailabilityRuleLike = {dayOfWeek: 0, startMinute: 60, endMinute: 4 * 60, capacity: 1}; // Sun 1am-4am
    const slots = computeAvailability({
      service,
      rules: [earlyRule],
      exceptions: [],
      settings: {...settings, slotGranularityMinutes: 15},
      existingOccupied: [],
      fromUtc: Date.parse("2026-03-08T00:00:00-05:00") / 1000,
      toUtc: Date.parse("2026-03-09T00:00:00-04:00") / 1000,
      now: Date.parse("2026-03-01T00:00:00-05:00") / 1000,
    });
    // The 1:00-4:00am local window, on the granularity-15/duration-30 grid, has 12 candidate
    // start minutes (60..210); every one whose start OR end falls inside the nonexistent
    // 2:00-3:00 local hour (starts 90, 105, 120, 135, 150, 165) must be dropped, leaving exactly
    // the two before the gap and the three after it - with the correct, DIFFERENT UTC offsets on
    // either side of the transition (EST -05:00 before, EDT -04:00 after).
    expect(slots.map((s) => new Date(s.startAt * 1000).toISOString())).toEqual([
      "2026-03-08T06:00:00.000Z", // 1:00am EST
      "2026-03-08T06:15:00.000Z", // 1:15am EST
      "2026-03-08T07:00:00.000Z", // 3:00am EDT
      "2026-03-08T07:15:00.000Z", // 3:15am EDT
      "2026-03-08T07:30:00.000Z", // 3:30am EDT
    ]);
  });
});
