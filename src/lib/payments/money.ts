import type {LineItem, TaxLine} from "@/lib/models/Payment";

/**
 * Fiat line-item and tax arithmetic, computed server-side from `lineItems` rather than trusted
 * from the client, in fixed-point cents (integer arithmetic, then formatted back to a 2-decimal
 * string). This assumes every fiat currency this app invoices in uses 2 minor-unit decimal places
 * (USD, EUR, GBP, ...) - a documented limitation, not a silent one: a zero-decimal currency (JPY)
 * or a three-decimal one (BHD) is out of scope for this template and would need this module
 * extended with a currency->exponent table before use.
 */

function toCents(decimalAmount: string): bigint {
  const [whole = "0", frac = ""] = decimalAmount.split(".");
  const fracPadded = (frac + "00").slice(0, 2);
  const sign = whole.startsWith("-") ? -1n : 1n;
  const wholeAbs = whole.replace("-", "") || "0";
  return sign * (BigInt(wholeAbs) * 100n + BigInt(fracPadded));
}

function fromCents(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${sign}${whole}.${frac.toString().padStart(2, "0")}`;
}

/** `unitAmount * qty`, rounded to the nearest cent - `qty` may be fractional (e.g. 1.5 hours of a
 * time-based service). */
export function lineItemAmount(unitAmount: string, qty: number): string {
  const unitCents = toCents(unitAmount);
  // qty is a plain JS number (validated non-negative by createPaymentSchema); scale it to an
  // integer at 4 decimal places of precision before multiplying so a qty like 1.5 or 0.25 doesn't
  // silently truncate to 1.
  const qtyScaled = BigInt(Math.round(qty * 10_000));
  const totalCents = (unitCents * qtyScaled + 5_000n) / 10_000n; // round to nearest cent
  return fromCents(totalCents);
}

export function sumLineItems(lineItems: Pick<LineItem, "amount">[]): string {
  const total = lineItems.reduce((sum, item) => sum + toCents(item.amount), 0n);
  return fromCents(total);
}

/** Computes the tax amount for a flat `rate` (e.g. `"0.0825"`) applied to `subtotal`. */
export function computeTax(subtotal: string, rate: string): string {
  const subtotalCents = toCents(subtotal);
  const [rateWhole = "0", rateFrac = ""] = rate.split(".");
  const rateScale = 10n ** BigInt(Math.max(rateFrac.length, 1));
  const rateScaled = BigInt(rateWhole || "0") * rateScale + BigInt((rateFrac || "0").padEnd(rateFrac.length || 1, "0"));
  const taxCents = (subtotalCents * rateScaled + rateScale / 2n) / rateScale;
  return fromCents(taxCents);
}

export function addAmounts(a: string, b: string): string {
  return fromCents(toCents(a) + toCents(b));
}

export function buildTaxLine(subtotal: string, label: string, rate: string): TaxLine {
  return {label, rate, amount: computeTax(subtotal, rate)};
}
