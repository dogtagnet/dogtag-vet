import {describe, expect, it} from "vitest";
import {idealAmountBase, withDust, pickDust, DustExhaustedError} from "@/lib/payments/amountBase";

describe("idealAmountBase", () => {
  it("converts fiat to token base units and rounds UP to the next multiple of 1000", () => {
    // $50.00 at a rate of 2500.00 fiat/token, 18 decimals: 0.02 tokens = 20_000_000_000_000_000 wei,
    // already a multiple of 1000.
    expect(idealAmountBase("50.00", "2500.00", 18)).toBe(20_000_000_000_000_000n);
  });

  it("never rounds down - the base amount is always >= the exact fiat-equivalent conversion", () => {
    // $10.00 at $3.00/token, 6 decimals: 10/3 * 1_000_000 = 3_333_333.33... base units.
    const base = idealAmountBase("10.00", "3.00", 6);
    const exact = (10_000_000n * 10n ** 6n) / 3_000_000n; // same fixed-point ratio, floor
    expect(base).toBeGreaterThanOrEqual(exact);
    expect(base % 1000n).toBe(0n);
  });

  it("throws on a non-positive rate rather than dividing by zero", () => {
    expect(() => idealAmountBase("10.00", "0", 6)).toThrow();
  });
});

describe("withDust", () => {
  it("appends the dust value into the smallest 3 decimal digits", () => {
    expect(withDust(20_000_000_000_000_000n, 1)).toBe("20000000000000001");
    expect(withDust(20_000_000_000_000_000n, 999)).toBe("20000000000000999");
  });

  it("rejects a dust value outside 1-999", () => {
    expect(() => withDust(1000n, 0)).toThrow();
    expect(() => withDust(1000n, 1000)).toThrow();
  });
});

describe("pickDust", () => {
  it("finds the first unreserved dust value in order", async () => {
    const taken = new Set(["1000001", "1000002"]);
    const tryReserve = async (candidate: string) => {
      if (taken.has(candidate)) return false;
      taken.add(candidate);
      return true;
    };
    const result = await pickDust(1000000n, tryReserve);
    expect(result).toBe("1000003");
  });

  it("throws DustExhaustedError when every dust value 1-999 is already taken", async () => {
    const tryReserve = async () => false;
    await expect(pickDust(1000000n, tryReserve)).rejects.toBeInstanceOf(DustExhaustedError);
  });
});
