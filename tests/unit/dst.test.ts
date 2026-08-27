import {describe, expect, it} from "vitest";
import {
  addCalendarDays,
  dayOfWeekForDateStr,
  localDateMinuteToUtcSeconds,
  utcSecondsToLocalDateStr,
  utcSecondsToLocalMinuteOfDay,
} from "@/lib/booking/dst";

const NY = "America/New_York";

describe("localDateMinuteToUtcSeconds", () => {
  it("converts a plain winter (EST, UTC-5) local time correctly", () => {
    // 2026-01-15 noon EST -> 17:00 UTC
    const seconds = localDateMinuteToUtcSeconds("2026-01-15", 12 * 60, NY);
    expect(seconds).toBe(Date.parse("2026-01-15T17:00:00Z") / 1000);
  });

  it("converts a plain summer (EDT, UTC-4) local time correctly", () => {
    // 2026-07-15 noon EDT -> 16:00 UTC
    const seconds = localDateMinuteToUtcSeconds("2026-07-15", 12 * 60, NY);
    expect(seconds).toBe(Date.parse("2026-07-15T16:00:00Z") / 1000);
  });

  it("uses the pre-transition EST offset just before the spring-forward gap", () => {
    // 2026-03-08 1:00am EST (still -5) -> 06:00 UTC
    const seconds = localDateMinuteToUtcSeconds("2026-03-08", 60, NY);
    expect(seconds).toBe(Date.parse("2026-03-08T06:00:00Z") / 1000);
  });

  it("rejects a local time inside the spring-forward gap (2026-03-08, clocks jump 2:00 -> 3:00)", () => {
    const seconds = localDateMinuteToUtcSeconds("2026-03-08", 2 * 60 + 30, NY);
    expect(seconds).toBeNull();
  });

  it("uses the post-transition EDT offset just after the spring-forward gap", () => {
    // 2026-03-08 3:20am EDT (-4) -> 07:20 UTC
    const seconds = localDateMinuteToUtcSeconds("2026-03-08", 3 * 60 + 20, NY);
    expect(seconds).toBe(Date.parse("2026-03-08T07:20:00Z") / 1000);
  });

  it("accepts the ambiguous fall-back hour (2026-11-01, 1:00-2:00 occurs twice) as a valid instant", () => {
    const seconds = localDateMinuteToUtcSeconds("2026-11-01", 60 + 30, NY);
    expect(seconds).not.toBeNull();
  });

  it("is independent of the host process's own timezone (regression: must not use Date.UTC/getUTC* against date-fns-tz)", () => {
    // This is exercised implicitly by every case above running correctly on this CI/dev host,
    // whatever its local TZ happens to be - date-fns-tz round-trips through *local* Date getters,
    // and localDateMinuteToUtcSeconds must consistently use the same convention throughout.
    const seconds = localDateMinuteToUtcSeconds("2026-01-15", 0, NY);
    expect(seconds).toBe(Date.parse("2026-01-15T05:00:00Z") / 1000);
  });
});

describe("dayOfWeekForDateStr", () => {
  it("computes the correct ISO weekday regardless of timezone", () => {
    // 2026-01-15 is a Thursday
    expect(dayOfWeekForDateStr("2026-01-15")).toBe(4);
    // 2026-01-18 is a Sunday
    expect(dayOfWeekForDateStr("2026-01-18")).toBe(0);
  });
});

describe("addCalendarDays", () => {
  it("adds days across a month boundary", () => {
    expect(addCalendarDays("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("subtracts days across a year boundary", () => {
    expect(addCalendarDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("crosses the spring-forward date without incident (pure calendar math)", () => {
    expect(addCalendarDays("2026-03-07", 1)).toBe("2026-03-08");
  });
});

describe("utcSecondsToLocalDateStr", () => {
  it("returns the clinic-local calendar date for a UTC instant", () => {
    expect(utcSecondsToLocalDateStr(Date.parse("2026-01-15T17:00:00Z") / 1000, NY)).toBe("2026-01-15");
  });

  it("rolls back to the previous local date late at night UTC", () => {
    // 2026-01-15T02:00:00Z is 2026-01-14 9:00pm EST
    expect(utcSecondsToLocalDateStr(Date.parse("2026-01-15T02:00:00Z") / 1000, NY)).toBe("2026-01-14");
  });
});

describe("utcSecondsToLocalMinuteOfDay", () => {
  it("inverts localDateMinuteToUtcSeconds", () => {
    const seconds = localDateMinuteToUtcSeconds("2026-01-15", 9 * 60 + 30, NY);
    expect(seconds).not.toBeNull();
    expect(utcSecondsToLocalMinuteOfDay(seconds as number, NY)).toBe(9 * 60 + 30);
  });

  it("accounts for the DST offset change", () => {
    const seconds = localDateMinuteToUtcSeconds("2026-07-15", 9 * 60 + 30, NY);
    expect(seconds).not.toBeNull();
    expect(utcSecondsToLocalMinuteOfDay(seconds as number, NY)).toBe(9 * 60 + 30);
  });
});
