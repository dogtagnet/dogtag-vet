import {describe, expect, it} from "vitest";
import {truncateMiddle, formatCountdown, formatUnixSeconds, formatTokenAmount} from "@/lib/format";

describe("truncateMiddle", () => {
  it("leaves short values intact", () => {
    expect(truncateMiddle("0xabc")).toBe("0xabc");
  });

  it("middle-truncates a long value with the default prefix/suffix", () => {
    const address = "0x1234567890abcdef1234567890abcdef12345678";
    expect(truncateMiddle(address)).toBe("0x1234...5678");
  });

  it("respects a custom prefix and suffix", () => {
    const hash = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    expect(truncateMiddle(hash, 4, 4)).toBe("0xde...beef");
  });

  it("does not truncate a value exactly at the boundary", () => {
    // length <= prefix + suffix + 3 stays intact
    const boundary = "1234567890123"; // 13 chars, prefix(6)+suffix(4)+3=13
    expect(truncateMiddle(boundary)).toBe(boundary);
  });
});

describe("formatCountdown", () => {
  it("formats whole minutes and seconds as m:ss", () => {
    expect(formatCountdown(600)).toBe("10:00");
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(9)).toBe("0:09");
  });

  it("floors fractional seconds", () => {
    expect(formatCountdown(59.9)).toBe("0:59");
  });

  it("clamps negative remaining time to zero", () => {
    expect(formatCountdown(-42)).toBe("0:00");
  });

  it("switches to Hh Mm beyond an hour", () => {
    expect(formatCountdown(3600)).toBe("1h 0m");
    expect(formatCountdown(3660)).toBe("1h 1m");
  });

  it("switches to Dd Hh beyond a day - a multi-day payment window never reads as raw minutes", () => {
    // the reported bug: a 7-day invoice previously rendered "10061:46"
    expect(formatCountdown(603_706)).toBe("6d 23h");
    expect(formatCountdown(7 * 86400)).toBe("7d 0h");
  });
});

describe("formatUnixSeconds", () => {
  const noonUtc = Date.UTC(2026, 7, 26, 12, 0, 0) / 1000; // 2026-08-26T12:00:00Z

  it("renders in the given clinic timezone, not the host timezone", () => {
    expect(formatUnixSeconds(noonUtc, "America/New_York")).toBe("Aug 26, 2026, 8:00 AM");
    expect(formatUnixSeconds(noonUtc, "Asia/Tokyo")).toBe("Aug 26, 2026, 9:00 PM");
  });

  it("appends the zone abbreviation only when asked", () => {
    expect(formatUnixSeconds(noonUtc, "America/New_York", true)).toBe("Aug 26, 2026, 8:00 AM EDT");
  });
});

describe("formatTokenAmount", () => {
  it("converts base units to an exact decimal string without rounding", () => {
    expect(formatTokenAmount("41436327650000237", 18)).toBe("0.041436327650000237");
  });

  it("handles a zero-decimal-remainder amount", () => {
    expect(formatTokenAmount("1000000", 6)).toBe("1");
  });
});
