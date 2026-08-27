import type {PaymentStatus} from "@/lib/models/Payment";
import {addAmounts} from "@/lib/payments/money";

export interface AccountingRow {
  createdAt: Date;
  status: PaymentStatus;
  currency: string;
  total: string;
}

export interface MonthlyTotal {
  month: string; // "YYYY-MM", clinic-local month bucketing is out of scope for v1 - UTC month
  status: PaymentStatus;
  currency: string;
  total: string;
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Monthly totals by status and currency - wp4-vet.md's accounting view. Pure so it is directly
 * unit-testable against fixture rows; the API route supplies the real ones from Mongo. */
export function aggregateMonthlyTotals(rows: AccountingRow[]): MonthlyTotal[] {
  const buckets = new Map<string, MonthlyTotal>();
  for (const row of rows) {
    const month = monthKey(row.createdAt);
    const key = `${month}:${row.status}:${row.currency}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.total = addAmounts(existing.total, row.total);
    } else {
      buckets.set(key, {month, status: row.status, currency: row.currency, total: row.total});
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.month.localeCompare(b.month) || a.status.localeCompare(b.status));
}

/** RFC-4180-ish CSV rendering of the monthly totals (no embedded commas/quotes in any field this
 * ever produces, so no escaping logic is needed - month/status/currency are all fixed-alphabet and
 * `total` is a canonical decimal string). */
export function monthlyTotalsToCsv(rows: MonthlyTotal[]): string {
  const header = "month,status,currency,total";
  const lines = rows.map((r) => `${r.month},${r.status},${r.currency},${r.total}`);
  return [header, ...lines].join("\n") + "\n";
}
