import {describe, expect, it} from "vitest";
import {maskClientName} from "@/lib/registration/mask";

/**
 * `maskClientName` is the ONLY form of a client's name that ever reaches a public route
 * (`GET /w/:token`'s `maskedClientName` - plans/wp4.2-client-wallet-registration.md: "masked name
 * only, NEVER raw PII (mask: first letter per word + asterisks)"). These tests pin the exact
 * masking shape so a future edit cannot accidentally widen it back toward the raw name.
 */
describe("maskClientName", () => {
  it("keeps the first letter of each word and replaces the rest with asterisks", () => {
    expect(maskClientName("Jordan Alvarez")).toBe("J***** A******");
  });

  it("never includes any letter beyond the first of any word", () => {
    const masked = maskClientName("Jordan Alvarez");
    expect(masked).not.toContain("ordan");
    expect(masked).not.toContain("lvarez");
  });

  it("handles a single-word name", () => {
    expect(maskClientName("Cher")).toBe("C***");
  });

  it("handles a single-letter word without emitting a stray asterisk", () => {
    expect(maskClientName("A")).toBe("A");
  });

  it("preserves the number of words for a multi-word name", () => {
    expect(maskClientName("Mary Jane Watson")).toBe("M*** J*** W*****");
  });

  it("collapses repeated internal whitespace to single spaces between masked words", () => {
    expect(maskClientName("Jordan   Alvarez")).toBe("J***** A******");
  });

  it("trims leading and trailing whitespace before masking", () => {
    expect(maskClientName("  Jordan Alvarez  ")).toBe("J***** A******");
  });

  it("is deterministic for the same input", () => {
    expect(maskClientName("Widget Clinic Owner")).toBe(maskClientName("Widget Clinic Owner"));
  });
});
