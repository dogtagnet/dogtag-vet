import {describe, expect, it} from "vitest";
import {computeRecordValidity, formatIsoCalendarDate, recordValidUntilCutoffUtc} from "@/lib/records/validity";

// Plan section 11.2's non-negotiable, verbatim: "validity = valid through the END of validUntil in
// UTC ... must pin with tests at the boundary, i.e., validUntil T24:00:00Z cutoff, not
// start-of-day". These tests pin the exact instant on both sides, not just "roughly a day".
describe("recordValidUntilCutoffUtc", () => {
  it("is the START of the day AFTER validUntil, at 00:00:00.000 UTC - not the start of validUntil's own day", () => {
    expect(recordValidUntilCutoffUtc("2027-09-01").toISOString()).toBe("2027-09-02T00:00:00.000Z");
  });

  it("rolls over a month boundary correctly (Date.UTC's own day-rollover arithmetic)", () => {
    expect(recordValidUntilCutoffUtc("2027-01-31").toISOString()).toBe("2027-02-01T00:00:00.000Z");
  });

  it("rolls over a year boundary correctly", () => {
    expect(recordValidUntilCutoffUtc("2027-12-31").toISOString()).toBe("2028-01-01T00:00:00.000Z");
  });

  it("rolls over a leap-day correctly", () => {
    expect(recordValidUntilCutoffUtc("2028-02-29").toISOString()).toBe("2028-03-01T00:00:00.000Z");
  });

  it("rejects anything that is not a plain YYYY-MM-DD string", () => {
    expect(() => recordValidUntilCutoffUtc("2027-09-01T00:00:00Z")).toThrow(/not an ISO date/);
    expect(() => recordValidUntilCutoffUtc("not-a-date")).toThrow(/not an ISO date/);
  });
});

describe("computeRecordValidity", () => {
  const VALID_UNTIL = "2027-09-01";

  it("is 'valid' at the very START of validUntil's own day (00:00:00.000Z) - proving the cutoff is NOT start-of-day", () => {
    const now = new Date("2027-09-01T00:00:00.000Z");
    expect(computeRecordValidity("active", VALID_UNTIL, now)).toBe("valid");
  });

  it("is 'valid' at the very LAST millisecond of validUntil's own day (23:59:59.999Z)", () => {
    const now = new Date("2027-09-01T23:59:59.999Z");
    expect(computeRecordValidity("active", VALID_UNTIL, now)).toBe("valid");
  });

  it("is 'expired' at the very FIRST millisecond of the day after validUntil (00:00:00.000Z)", () => {
    const now = new Date("2027-09-02T00:00:00.000Z");
    expect(computeRecordValidity("active", VALID_UNTIL, now)).toBe("expired");
  });

  it("is 'expired' well after validUntil", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    expect(computeRecordValidity("active", VALID_UNTIL, now)).toBe("expired");
  });

  it("status 'revoked' always wins over the date comparison, even while still inside the valid window", () => {
    const now = new Date("2027-01-01T00:00:00.000Z"); // long before VALID_UNTIL
    expect(computeRecordValidity("revoked", VALID_UNTIL, now)).toBe("revoked");
  });

  it("status 'revoked' always wins over the date comparison, even long after validUntil", () => {
    const now = new Date("2030-01-01T00:00:00.000Z"); // long after VALID_UNTIL
    expect(computeRecordValidity("revoked", VALID_UNTIL, now)).toBe("revoked");
  });

  it.each(["draft", "issuing", "error"] as const)("status '%s' reports 'pending' regardless of the date", (status) => {
    expect(computeRecordValidity(status, VALID_UNTIL, new Date("2020-01-01T00:00:00.000Z"))).toBe("pending");
    expect(computeRecordValidity(status, VALID_UNTIL, new Date("2099-01-01T00:00:00.000Z"))).toBe("pending");
  });
});

describe("formatIsoCalendarDate", () => {
  it("renders a bare calendar date pinned to UTC (never shifts a day depending on the reader's own timezone)", () => {
    expect(formatIsoCalendarDate("2027-09-01")).toBe("Sep 1, 2027");
  });

  it("passes through anything that is not a plain YYYY-MM-DD string unchanged", () => {
    expect(formatIsoCalendarDate("not-a-date")).toBe("not-a-date");
  });
});
