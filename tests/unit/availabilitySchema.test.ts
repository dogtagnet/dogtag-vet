import {describe, expect, it} from "vitest";
import {bookingSettingsSchema} from "@/lib/schemas/availability";

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
