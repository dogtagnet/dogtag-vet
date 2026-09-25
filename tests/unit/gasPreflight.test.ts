import {describe, expect, it} from "vitest";
import {checkGasPreflight, formatPlasmaApprox, gasPreflightMessage} from "@/lib/gasPreflight";

describe("checkGasPreflight (WP4.19 V3 - the exact arithmetic issue/revoke/reactivate refuse to send under)", () => {
  it("refuses when the balance is below gasFloor * gasPrice", () => {
    // floor 400_000, price 1000 wei -> needs 400_000_000 wei.
    const result = checkGasPreflight(399_999_999n, 1000n, 400_000n);
    expect(result.ok).toBe(false);
    expect(result.neededWei).toBe(400_000_000n);
  });

  it("allows exactly at the boundary (balance == needed, not merely close)", () => {
    const result = checkGasPreflight(400_000_000n, 1000n, 400_000n);
    expect(result.ok).toBe(true);
    expect(result.neededWei).toBe(400_000_000n);
  });

  it("allows comfortably above the boundary", () => {
    const result = checkGasPreflight(1_000_000_000n, 1000n, 400_000n);
    expect(result.ok).toBe(true);
  });

  it("a zero balance always refuses whenever needed > 0 - the V3 e2e's own scripted scenario", () => {
    const result = checkGasPreflight(0n, 1n, 400_000n);
    expect(result.ok).toBe(false);
    expect(result.neededWei).toBe(400_000n);
  });

  it("a zero gas price needs 0 wei, so even a zero balance passes (never divides by/multiplies into a false positive)", () => {
    const result = checkGasPreflight(0n, 0n, 400_000n);
    expect(result.ok).toBe(true);
    expect(result.neededWei).toBe(0n);
  });

  it("scales with the floor - addSecondaryOwner's much larger floor needs proportionally more", () => {
    const revokeTag = checkGasPreflight(0n, 1_000_007n, 400_000n);
    const addSecondaryOwner = checkGasPreflight(0n, 1_000_007n, 1_600_000n);
    expect(addSecondaryOwner.neededWei).toBeGreaterThan(revokeTag.neededWei);
    expect(addSecondaryOwner.neededWei).toBe(1_600_000n * 1_000_007n);
  });
});

describe("formatPlasmaApprox", () => {
  it("formats a whole-PLASMA amount with no trailing zeros or decimal point", () => {
    expect(formatPlasmaApprox(1_000_000_000_000_000_000n)).toBe("1");
  });

  it("formats a sub-PLASMA amount, trimmed to at most 6 fraction digits", () => {
    // 400_000 wei * 1000 wei/gas = 0.0000000000000004 PLASMA - far below 6 decimal places, so the
    // whole fraction is trimmed away entirely.
    expect(formatPlasmaApprox(400_000_000n)).toBe("0");
  });

  it("keeps a meaningful sub-PLASMA amount within 6 decimal places, trimming trailing zeros", () => {
    // 0.084 PLASMA exactly.
    expect(formatPlasmaApprox(84_000_000_000_000_000n)).toBe("0.084");
  });

  it("never emits scientific notation for a very small nonzero amount", () => {
    const result = formatPlasmaApprox(1n);
    expect(result).not.toMatch(/e/i);
  });
});

describe("gasPreflightMessage", () => {
  it("uses Kenneth's exact copy with the formatted needed amount", () => {
    const message = gasPreflightMessage(84_000_000_000_000_000n);
    expect(message).toBe("Your wallet needs about 0.084 PLASMA for this transaction; ask your admin for a top-up");
  });
});
