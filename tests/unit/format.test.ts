import {describe, expect, it} from "vitest";
import {truncateMiddle, formatCountdown} from "@/lib/format";

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
});
