import {describe, expect, it} from "vitest";
import {availabilityExceptionSchema, availabilityRuleSchema, bookingSettingsSchema} from "@/lib/schemas/availability";

/**
 * WP4.5 issue 2's server-hardening step: bookingSettingsSchema.timezone was `z.string().min(1)`,
 * so any junk string stored (a bad zone later crashes Intl.DateTimeFormat call sites like
 * `todayInTimeZone` - SSR 500s on /calendar and /dashboard - or silently produces Invalid Date via
 * date-fns-tz's fromZonedTime, vanishing every booking slot). isValidTimeZone rejects that at the
 * API boundary while still accepting legacy aliases already in use (see timezones.test.ts).
 */
const validBase = {
  timezone: "America/New_York",
  minNoticeMinutes: 60,
  maxAdvanceDays: 60,
  slotGranularityMinutes: 30,
};

describe("bookingSettingsSchema - timezone validity", () => {
  it("accepts a well-formed IANA zone", () => {
    expect(bookingSettingsSchema.safeParse(validBase).success).toBe(true);
  });

  it.each(["UTC", "Etc/GMT+5", "Asia/Kolkata"])("accepts the legacy/POSIX-style zone %s", (timezone) => {
    const parsed = bookingSettingsSchema.safeParse({...validBase, timezone});
    expect(parsed.success).toBe(true);
  });

  it.each(["America/NewYork", "Not/AZone", "junk", ""])("rejects the malformed zone %j", (timezone) => {
    const parsed = bookingSettingsSchema.safeParse({...validBase, timezone});
    expect(parsed.success).toBe(false);
  });

  it("still validates the other fields independently of the timezone refinement", () => {
    const parsed = bookingSettingsSchema.safeParse({...validBase, minNoticeMinutes: -1});
    expect(parsed.success).toBe(false);
  });
});

/**
 * WP4.7 A3/D1: schedulingMode is optional at the WIRE/zod layer even though the mongoose model
 * requires it with a default - PATCH /api/availability/settings must not silently reset an
 * already-practitioner-mode clinic back to "clinic" on every unrelated settings save (the existing
 * BookingConfigSection form never sends this field at all; only A5's future mode-toggle control
 * will).
 */
describe("bookingSettingsSchema - schedulingMode (WP4.7 D1)", () => {
  it("back-compat: absent schedulingMode parses successfully and is not present in the output", () => {
    const parsed = bookingSettingsSchema.safeParse(validBase);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.schedulingMode).toBeUndefined();
  });

  it.each(["clinic", "practitioner"] as const)("accepts schedulingMode %s", (schedulingMode) => {
    const parsed = bookingSettingsSchema.safeParse({...validBase, schedulingMode});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.schedulingMode).toBe(schedulingMode);
  });

  it("rejects an unknown schedulingMode value", () => {
    const parsed = bookingSettingsSchema.safeParse({...validBase, schedulingMode: "solo"});
    expect(parsed.success).toBe(false);
  });
});

/** WP4.7 A3/D2: staffId is optional and back-compat-transparent on both the rule and exception
 * schemas - absent behaves exactly as every rule/exception created before this WP. */
describe("availabilityRuleSchema - staffId (WP4.7 D2)", () => {
  const validRule = {dayOfWeek: 1, startMinute: 540, endMinute: 600, capacity: 1};

  it("back-compat: absent staffId parses successfully and is not present in the output", () => {
    const parsed = availabilityRuleSchema.safeParse(validRule);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.staffId).toBeUndefined();
  });

  it("accepts a present staffId", () => {
    const parsed = availabilityRuleSchema.safeParse({...validRule, staffId: "staff-123"});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.staffId).toBe("staff-123");
  });

  it("rejects an empty-string staffId (must be a real id, not accidentally-cleared)", () => {
    const parsed = availabilityRuleSchema.safeParse({...validRule, staffId: ""});
    expect(parsed.success).toBe(false);
  });

  it("the endMinute > startMinute refinement still applies with staffId present", () => {
    const parsed = availabilityRuleSchema.safeParse({...validRule, staffId: "staff-123", endMinute: 500});
    expect(parsed.success).toBe(false);
  });
});

describe("availabilityExceptionSchema - staffId (WP4.7 D2/D3)", () => {
  const validException = {date: "2026-12-25", closed: true};

  it("back-compat: absent staffId parses successfully and is not present in the output", () => {
    const parsed = availabilityExceptionSchema.safeParse(validException);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.staffId).toBeUndefined();
  });

  it("accepts a present staffId", () => {
    const parsed = availabilityExceptionSchema.safeParse({...validException, staffId: "staff-123"});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.staffId).toBe("staff-123");
  });

  it("rejects an empty-string staffId", () => {
    const parsed = availabilityExceptionSchema.safeParse({...validException, staffId: ""});
    expect(parsed.success).toBe(false);
  });
});
