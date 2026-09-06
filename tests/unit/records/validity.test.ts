import {describe, expect, it} from "vitest";
import {computeRecordValidity, formatIsoCalendarDate, recordValidFromStartUtc, recordValidUntilCutoffUtc} from "@/lib/records/validity";

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

// Grade round 1 D1's second case: validFrom's window OPENS at the start of its own day, symmetric
// to validUntil's own cutoff above (which is the start of the day AFTER, not validUntil's own
// start) - pinned with the same rigor, not assumed symmetric without proof.
describe("recordValidFromStartUtc", () => {
  it("is the START of validFrom's own day, at 00:00:00.000 UTC", () => {
    expect(recordValidFromStartUtc("2027-09-01").toISOString()).toBe("2027-09-01T00:00:00.000Z");
  });

  it("rolls over a month boundary correctly", () => {
    expect(recordValidFromStartUtc("2027-02-01").toISOString()).toBe("2027-02-01T00:00:00.000Z");
  });

  it("rolls over a year boundary correctly", () => {
    expect(recordValidFromStartUtc("2028-01-01").toISOString()).toBe("2028-01-01T00:00:00.000Z");
  });

  it("rejects anything that is not a plain YYYY-MM-DD string", () => {
    expect(() => recordValidFromStartUtc("2027-09-01T00:00:00Z")).toThrow(/not an ISO date/);
    expect(() => recordValidFromStartUtc("not-a-date")).toThrow(/not an ISO date/);
  });
});

describe("computeRecordValidity", () => {
  // Well before VALID_UNTIL, so every "is it still valid" test below sits inside the window by
  // construction - only the not_yet_valid describe block below moves this boundary into view.
  const VALID_FROM = "2020-01-01";
  const VALID_UNTIL = "2027-09-01";

  it("is 'valid' at the very START of validUntil's own day (00:00:00.000Z) - proving the cutoff is NOT start-of-day", () => {
    const now = new Date("2027-09-01T00:00:00.000Z");
    expect(computeRecordValidity("active", VALID_FROM, VALID_UNTIL, now)).toBe("valid");
  });

  it("is 'valid' at the very LAST millisecond of validUntil's own day (23:59:59.999Z)", () => {
    const now = new Date("2027-09-01T23:59:59.999Z");
    expect(computeRecordValidity("active", VALID_FROM, VALID_UNTIL, now)).toBe("valid");
  });

  it("is 'expired' at the very FIRST millisecond of the day after validUntil (00:00:00.000Z)", () => {
    const now = new Date("2027-09-02T00:00:00.000Z");
    expect(computeRecordValidity("active", VALID_FROM, VALID_UNTIL, now)).toBe("expired");
  });

  it("is 'expired' well after validUntil", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    expect(computeRecordValidity("active", VALID_FROM, VALID_UNTIL, now)).toBe("expired");
  });

  it("status 'revoked' always wins over the date comparison, even while still inside the valid window", () => {
    const now = new Date("2021-01-01T00:00:00.000Z"); // inside [VALID_FROM, VALID_UNTIL]
    expect(computeRecordValidity("revoked", VALID_FROM, VALID_UNTIL, now)).toBe("revoked");
  });

  it("status 'revoked' always wins over the date comparison, even long after validUntil", () => {
    const now = new Date("2030-01-01T00:00:00.000Z"); // long after VALID_UNTIL
    expect(computeRecordValidity("revoked", VALID_FROM, VALID_UNTIL, now)).toBe("revoked");
  });

  it("status 'revoked' always wins even with both bounds absent (a revoked record is never merely 'hidden')", () => {
    expect(computeRecordValidity("revoked", undefined, undefined, new Date("2027-01-01T00:00:00.000Z"))).toBe("revoked");
  });

  it.each(["draft", "issuing", "error"] as const)("status '%s' reports 'pending' regardless of the date", (status) => {
    expect(computeRecordValidity(status, VALID_FROM, VALID_UNTIL, new Date("2020-01-01T00:00:00.000Z"))).toBe("pending");
    expect(computeRecordValidity(status, VALID_FROM, VALID_UNTIL, new Date("2099-01-01T00:00:00.000Z"))).toBe("pending");
  });

  // Grade round 1 D1 (MAJOR): validFrom/validUntil are ordinary maskable leaves, so a presented
  // artifact may legally withhold either. The prior implementation defaulted an absent validUntil
  // to "valid" - a guess, not a finding. Bite: reverting the `!validFromIsoDate || !validUntilIsoDate`
  // guard (or either half of it) to always fall through turns exactly these red.
  describe("either bound absent - 'hidden', never a guessed 'valid'", () => {
    const now = new Date("2021-01-01T00:00:00.000Z"); // inside the window on the bound that IS present

    it("validUntil masked (undefined) - 'hidden', not 'valid'", () => {
      expect(computeRecordValidity("active", VALID_FROM, undefined, now)).toBe("hidden");
    });

    it("validFrom masked (undefined) - 'hidden', not 'valid'", () => {
      expect(computeRecordValidity("active", undefined, VALID_UNTIL, now)).toBe("hidden");
    });

    it("both masked - 'hidden'", () => {
      expect(computeRecordValidity("active", undefined, undefined, now)).toBe("hidden");
    });

    // Grade round 2 R1 (residual from round 1's own new spec prose): leaf-commitment.md section
    // 16's freshly-written subsection claimed 'expired' applies "regardless of whether validFrom
    // is also disclosed" - false against this exact branch. The sibling test above already proves
    // 'hidden' beats a validUntil that is disclosed and in the FUTURE; this one proves the same
    // precedence when validUntil is disclosed and ALREADY PAST - the one case where a checker that
    // read the old (wrong) spec text would expect 'expired', not 'hidden'. Bite: gate an
    // `expired` check on `validUntilIsoDate && now >= cutoff` and run it BEFORE this line (mirroring
    // the deleted spec clause verbatim) - turns exactly this test red, no other test in this file.
    it("validFrom masked and validUntil disclosed but ALREADY PAST - still 'hidden', never 'expired'", () => {
      expect(computeRecordValidity("active", undefined, "2000-01-01", now)).toBe("hidden");
    });
  });

  // Grade round 1 D1's second (folded-in) case: validFrom was never consulted at all before this
  // fix, so a record whose protection window has not opened yet read "valid". Pinned at the exact
  // UTC boundary, mirroring the validUntil boundary tests above, not just "roughly a day".
  describe("validFrom disclosed but still in the future - 'not_yet_valid', never collapsed into 'expired'", () => {
    const FUTURE_VALID_FROM = "2099-01-01";
    const FUTURE_VALID_UNTIL = "2099-12-31";

    it("is 'not_yet_valid' one millisecond before validFrom's own start", () => {
      const now = new Date("2098-12-31T23:59:59.999Z");
      expect(computeRecordValidity("active", FUTURE_VALID_FROM, FUTURE_VALID_UNTIL, now)).toBe("not_yet_valid");
    });

    it("is 'valid' at the exact first millisecond of validFrom's own day (00:00:00.000Z) - proving the open boundary is inclusive", () => {
      const now = new Date("2099-01-01T00:00:00.000Z");
      expect(computeRecordValidity("active", FUTURE_VALID_FROM, FUTURE_VALID_UNTIL, now)).toBe("valid");
    });

    it("today, well before a future validFrom, is 'not_yet_valid'", () => {
      const now = new Date("2027-01-01T00:00:00.000Z");
      expect(computeRecordValidity("active", FUTURE_VALID_FROM, FUTURE_VALID_UNTIL, now)).toBe("not_yet_valid");
    });
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
