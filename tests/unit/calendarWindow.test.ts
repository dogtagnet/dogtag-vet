import {describe, expect, it} from "vitest";
import {computeCalendarWindow} from "@/lib/booking/calendarWindow";
import {localDateMinuteToUtcSeconds} from "@/lib/booking/dst";

const NY = "America/New_York";
const NORMAL_RULE = {startMinute: 480, endMinute: 1080}; // 08:00-18:00

function localInstant(minuteOfDay: number): number {
  const seconds = localDateMinuteToUtcSeconds("2026-03-10", minuteOfDay, NY);
  if (seconds === null) throw new Error("test fixture produced an invalid local instant");
  return seconds;
}

describe("computeCalendarWindow", () => {
  it("keeps the default rule-derived window when nothing pushes past it", () => {
    const window = computeCalendarWindow({
      rules: [NORMAL_RULE],
      exceptions: [],
      appointments: [],
      timeZone: NY,
    });
    expect(window.dayStartMinute).toBe(480);
    expect(window.dayEndMinute).toBe(1080);
    expect(window.hasHoursOutsideRules).toBe(false);
  });

  it("renders a 07:00 appointment booked on an exception day within the grid", () => {
    // The round-6 finding: an extended-hours exception (07:00-18:00) let staff book a 07:00
    // appointment, but the grid's window - derived from AvailabilityRule alone - started at 08:00,
    // so the confirmed appointment rendered nowhere.
    const appointmentStart = localInstant(7 * 60); // 07:00 local
    const appointmentEnd = localInstant(7 * 60 + 30);
    const window = computeCalendarWindow({
      rules: [NORMAL_RULE],
      exceptions: [{startMinute: 7 * 60, endMinute: 1080}],
      appointments: [{startAt: appointmentStart, endAt: appointmentEnd}],
      timeZone: NY,
    });
    expect(window.dayStartMinute).toBeLessThanOrEqual(7 * 60);
    expect(window.dayEndMinute).toBeGreaterThan(7 * 60 + 30);
    expect(window.hasHoursOutsideRules).toBe(true);
  });

  it("widens for an exception's extended window even before anything is booked into it", () => {
    // Staff should be able to click-to-create in the extended hours, not just see appointments
    // already booked there.
    const window = computeCalendarWindow({
      rules: [NORMAL_RULE],
      exceptions: [{startMinute: 7 * 60, endMinute: 1080}],
      appointments: [],
      timeZone: NY,
    });
    expect(window.dayStartMinute).toBe(7 * 60);
    expect(window.hasHoursOutsideRules).toBe(true);
  });

  it("widens for a booked appointment even with no matching exception on record", () => {
    // Belt-and-suspenders: no booked appointment can ever fall outside the grid, regardless of
    // whether an AvailabilityException document explains why it exists (e.g. a staff-created
    // ad-hoc booking before hours).
    const appointmentStart = localInstant(6 * 60 + 30); // 06:30 local
    const appointmentEnd = localInstant(7 * 60);
    const window = computeCalendarWindow({
      rules: [NORMAL_RULE],
      exceptions: [],
      appointments: [{startAt: appointmentStart, endAt: appointmentEnd}],
      timeZone: NY,
    });
    expect(window.dayStartMinute).toBeLessThanOrEqual(6 * 60 + 30);
    expect(window.hasHoursOutsideRules).toBe(true);
  });

  it("widens the end of the window for a late appointment that runs past closing", () => {
    const appointmentStart = localInstant(17 * 60 + 30); // 17:30 local
    const appointmentEnd = localInstant(19 * 60); // 19:00 local, 90 minutes long
    const window = computeCalendarWindow({
      rules: [NORMAL_RULE],
      exceptions: [],
      appointments: [{startAt: appointmentStart, endAt: appointmentEnd}],
      timeZone: NY,
    });
    expect(window.dayEndMinute).toBeGreaterThanOrEqual(19 * 60);
    expect(window.hasHoursOutsideRules).toBe(true);
  });

  it("falls back to the 08:00-18:00 default when there are no rules at all", () => {
    const window = computeCalendarWindow({rules: [], exceptions: [], appointments: [], timeZone: NY});
    expect(window.dayStartMinute).toBe(480);
    expect(window.dayEndMinute).toBe(1080);
  });
});
