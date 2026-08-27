import {describe, expect, it} from "vitest";
import {lineItemAmount, sumLineItems, computeTax, addAmounts, buildTaxLine} from "@/lib/payments/money";

describe("lineItemAmount", () => {
  it("multiplies unit amount by an integer quantity", () => {
    expect(lineItemAmount("25.00", 3)).toBe("75.00");
  });

  it("handles a fractional quantity", () => {
    expect(lineItemAmount("100.00", 1.5)).toBe("150.00");
  });

  it("rounds to the nearest cent", () => {
    expect(lineItemAmount("10.00", 0.333)).toBe("3.33");
  });
});

describe("sumLineItems", () => {
  it("sums several line item amounts", () => {
    expect(sumLineItems([{amount: "10.00"}, {amount: "5.50"}, {amount: "0.25"}])).toBe("15.75");
  });

  it("returns 0.00 for no line items", () => {
    expect(sumLineItems([])).toBe("0.00");
  });
});

describe("computeTax", () => {
  it("applies a flat rate to the subtotal", () => {
    expect(computeTax("100.00", "0.0825")).toBe("8.25");
  });

  it("rounds to the nearest cent", () => {
    expect(computeTax("10.00", "0.0825")).toBe("0.83"); // 0.825 rounds to 0.83
  });
});

describe("addAmounts", () => {
  it("adds two decimal amounts", () => {
    expect(addAmounts("100.00", "8.25")).toBe("108.25");
  });
});

describe("buildTaxLine", () => {
  it("builds a full TaxLine from a label and rate", () => {
    expect(buildTaxLine("100.00", "Sales tax", "0.0825")).toEqual({label: "Sales tax", rate: "0.0825", amount: "8.25"});
  });
});
