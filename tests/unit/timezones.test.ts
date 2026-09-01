import {describe, expect, it} from "vitest";
import {filterTimeZones, isValidTimeZone, utcOffsetLabel} from "@/lib/timezones";

const SAMPLE_ZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "America/Argentina/Buenos_Aires",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Europe/Berlin",
  "Europe/London",
  "Australia/Sydney",
  "Pacific/Auckland",
];

describe("filterTimeZones", () => {
  it("returns nothing for an empty or whitespace-only query - the picker shows nothing until the user types", () => {
    expect(filterTimeZones("", SAMPLE_ZONES)).toEqual([]);
    expect(filterTimeZones("   ", SAMPLE_ZONES)).toEqual([]);
  });

  it("matches case-insensitively with '/' and '_' normalized to spaces - \"new york\" matches America/New_York", () => {
    const result = filterTimeZones("new york", SAMPLE_ZONES);
    expect(result).toContain("America/New_York");
  });

  it("normalizes the QUERY's own underscore too, not just the haystack's - \"New_York\" (typed with the IANA delimiter) matches America/New_York", () => {
    const result = filterTimeZones("New_York", SAMPLE_ZONES);
    expect(result).toContain("America/New_York");
  });

  it("normalizes the QUERY's own slash too - a full zone id pasted verbatim (\"America/New_York\") still matches America/New_York", () => {
    const result = filterTimeZones("America/New_York", SAMPLE_ZONES);
    expect(result).toContain("America/New_York");
  });

  it("normalizes both '/' and '_' together in a multi-segment pasted id - \"America/Argentina/Buenos_Aires\" matches its own zone", () => {
    const result = filterTimeZones("America/Argentina/Buenos_Aires", SAMPLE_ZONES);
    expect(result).toContain("America/Argentina/Buenos_Aires");
  });

  it("matches a partial city prefix, e.g. \"los ang\" matches America/Los_Angeles", () => {
    const result = filterTimeZones("los ang", SAMPLE_ZONES);
    expect(result).toEqual(["America/Los_Angeles"]);
  });

  it("is case-insensitive on the query itself", () => {
    expect(filterTimeZones("TOKYO", SAMPLE_ZONES)).toEqual(["Asia/Tokyo"]);
    expect(filterTimeZones("ToKyO", SAMPLE_ZONES)).toEqual(["Asia/Tokyo"]);
  });

  it("ranks a prefix match (city or region name starts with the query) ahead of a mere substring match", () => {
    // "alpha" is a PREFIX of Region/Alpha's second segment, but only a SUBSTRING (starting mid-word)
    // of Region/Zalpha's - the prefix hit must sort first even though Zalpha would come first
    // alphabetically among the raw inputs.
    const zones = ["Region/Zalpha", "Region/Alpha"];
    expect(filterTimeZones("alpha", zones)).toEqual(["Region/Alpha", "Region/Zalpha"]);
  });

  it("still returns a pure substring match when nothing prefix-matches", () => {
    const zones = ["Region/Zalpha", "Region/Beta"];
    expect(filterTimeZones("alpha", zones)).toEqual(["Region/Zalpha"]);
  });

  it("returns an empty array for a query matching nothing", () => {
    expect(filterTimeZones("NotAZone", SAMPLE_ZONES)).toEqual([]);
  });

  it("caps the result list at the given limit", () => {
    const manyZones = Array.from({length: 100}, (_, i) => `Etc/Zone${i}`);
    expect(filterTimeZones("zone", manyZones, 50)).toHaveLength(50);
  });

  it("defaults the cap to ~50 when no limit is passed", () => {
    const manyZones = Array.from({length: 100}, (_, i) => `Etc/Zone${i}`);
    expect(filterTimeZones("zone", manyZones).length).toBeLessThanOrEqual(50);
  });
});

describe("utcOffsetLabel", () => {
  it("formats America/New_York in January (EST) as UTC-05:00", () => {
    expect(utcOffsetLabel("America/New_York", new Date("2026-01-15T12:00:00Z"))).toBe("UTC-05:00");
  });

  it("formats America/New_York in July (EDT) as UTC-04:00 - deterministic regardless of host TZ", () => {
    expect(utcOffsetLabel("America/New_York", new Date("2026-07-15T12:00:00Z"))).toBe("UTC-04:00");
  });

  it("formats a positive-offset zone correctly, e.g. Asia/Kolkata as UTC+05:30", () => {
    expect(utcOffsetLabel("Asia/Kolkata", new Date("2026-01-15T12:00:00Z"))).toBe("UTC+05:30");
  });

  it("formats UTC itself as UTC+00:00 rather than a bare \"UTC\" with no offset digits", () => {
    expect(utcOffsetLabel("UTC", new Date("2026-01-15T12:00:00Z"))).toBe("UTC+00:00");
  });

  it("defaults `at` to now when omitted", () => {
    expect(() => utcOffsetLabel("America/New_York")).not.toThrow();
  });
});

describe("isValidTimeZone", () => {
  it.each(["America/New_York", "UTC", "Etc/GMT+5", "Asia/Kolkata"])("accepts %s", (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
  });

  // The plan's specific warning: some legacy/POSIX-style IANA aliases are not in
  // Intl.supportedValuesOf("timeZone") (the picker's own search source) but ARE accepted by the
  // runtime - membership-testing against that list would wrongly reject them, "UTC" included.
  it.each(["UTC", "Etc/GMT+5"])("accepts %s even though it is absent from Intl.supportedValuesOf(\"timeZone\")", (zone) => {
    expect(Intl.supportedValuesOf("timeZone").includes(zone)).toBe(false);
    expect(isValidTimeZone(zone)).toBe(true);
  });

  it.each(["America/NewYork", "", "Not/AZone", "Nowhere"])("rejects %s", (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
  });
});
