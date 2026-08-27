import {describe, expect, it} from "vitest";
import {aggregateMonthlyTotals, monthlyTotalsToCsv} from "@/lib/payments/accounting";

describe("aggregateMonthlyTotals", () => {
  it("sums totals grouped by month, status, and currency", () => {
    const rows = [
      {createdAt: new Date("2026-01-05T00:00:00Z"), status: "paid" as const, currency: "USD", total: "100.00"},
      {createdAt: new Date("2026-01-20T00:00:00Z"), status: "paid" as const, currency: "USD", total: "50.50"},
      {createdAt: new Date("2026-01-10T00:00:00Z"), status: "pending" as const, currency: "USD", total: "25.00"},
      {createdAt: new Date("2026-02-01T00:00:00Z"), status: "paid" as const, currency: "USD", total: "10.00"},
      {createdAt: new Date("2026-01-15T00:00:00Z"), status: "paid" as const, currency: "EUR", total: "5.00"},
    ];

    const result = aggregateMonthlyTotals(rows);

    expect(result).toContainEqual({month: "2026-01", status: "paid", currency: "USD", total: "150.50"});
    expect(result).toContainEqual({month: "2026-01", status: "pending", currency: "USD", total: "25.00"});
    expect(result).toContainEqual({month: "2026-02", status: "paid", currency: "USD", total: "10.00"});
    expect(result).toContainEqual({month: "2026-01", status: "paid", currency: "EUR", total: "5.00"});
    expect(result).toHaveLength(4);
  });

  it("returns an empty list for no rows", () => {
    expect(aggregateMonthlyTotals([])).toEqual([]);
  });
});

describe("monthlyTotalsToCsv", () => {
  it("renders a header and one row per entry", () => {
    const csv = monthlyTotalsToCsv([{month: "2026-01", status: "paid", currency: "USD", total: "150.50"}]);
    expect(csv).toBe("month,status,currency,total\n2026-01,paid,USD,150.50\n");
  });

  it("renders just the header for an empty list", () => {
    expect(monthlyTotalsToCsv([])).toBe("month,status,currency,total\n");
  });
});
