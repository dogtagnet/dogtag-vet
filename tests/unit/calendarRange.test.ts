import {describe, expect, it} from "vitest";
import {calendarRangeFor, startOfWeek} from "@/lib/booking/calendarRange";

describe("startOfWeek", () => {
  it("returns the same date when it is already a Monday", () => {
    // 2026-01-19 is a Monday
    expect(startOfWeek("2026-01-19")).toBe("2026-01-19");
  });

  it("rolls back to Monday from mid-week", () => {
    // 2026-01-22 is a Thursday
    expect(startOfWeek("2026-01-22")).toBe("2026-01-19");
  });

  it("rolls back to Monday from Sunday", () => {
    // 2026-01-25 is a Sunday
    expect(startOfWeek("2026-01-25")).toBe("2026-01-19");
  });
});

describe("calendarRangeFor", () => {
  it("produces the correct number of consecutive dates and a matching UTC range", () => {
    const range = calendarRangeFor("2026-01-19", 7, "America/New_York");
    expect(range.dates).toEqual([
      "2026-01-19",
      "2026-01-20",
      "2026-01-21",
      "2026-01-22",
      "2026-01-23",
      "2026-01-24",
      "2026-01-25",
    ]);
    expect(range.fromUtc).toBe(Date.parse("2026-01-19T00:00:00-05:00") / 1000);
    expect(range.toUtc).toBe(Date.parse("2026-01-26T00:00:00-05:00") / 1000);
  });

  it("handles a single-day (day view) range", () => {
    const range = calendarRangeFor("2026-01-19", 1, "America/New_York");
    expect(range.dates).toEqual(["2026-01-19"]);
    expect(range.toUtc - range.fromUtc).toBe(86400);
  });
});
