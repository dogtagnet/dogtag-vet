import {describe, expect, it} from "vitest";
import {createPaymentSchema} from "@/lib/schemas/payment";

/**
 * WP4.18 V4 - "a rail without a manual rate cannot be created". ROAX rails are manual-rate only
 * (no live price feed to fall back to), so `manualRate` is a REQUIRED field on every
 * `acceptedRails` entry, enforced at the schema layer before `POST /api/payments` allocates
 * anything (invoice number, dust reservations) - see that route's own doc comment.
 */
function validPayment(acceptedRails: unknown[]) {
  return {
    lineItems: [{description: "Checkup", qty: 1, unitAmount: "75.00"}],
    currency: "USD",
    acceptedRails,
  };
}

describe("createPaymentSchema - manual-rate-only rails", () => {
  it("rejects a rail with no manualRate at all", () => {
    const parsed = createPaymentSchema.safeParse(validPayment([{chainKey: "roax", token: "PLASMA"}]));
    expect(parsed.success).toBe(false);
  });

  it("rejects a rail with an explicitly blank manualRate", () => {
    const parsed = createPaymentSchema.safeParse(validPayment([{chainKey: "roax", token: "RUSD", manualRate: ""}]));
    expect(parsed.success).toBe(false);
  });

  it("accepts a rail with a manualRate present", () => {
    const parsed = createPaymentSchema.safeParse(validPayment([{chainKey: "roax", token: "PLASMA", manualRate: "2500.00"}]));
    expect(parsed.success).toBe(true);
  });

  it("accepts RUSD's conventional 1.00 rate the same as any other decimal string", () => {
    const parsed = createPaymentSchema.safeParse(validPayment([{chainKey: "roax", token: "RUSD", manualRate: "1.00"}]));
    expect(parsed.success).toBe(true);
  });

  it("accepts a payment with no accepted rails at all - crypto payment is optional, not required", () => {
    const parsed = createPaymentSchema.safeParse(validPayment([]));
    expect(parsed.success).toBe(true);
  });

  it("rejects when ONE of two rails is missing a rate, even if the other has one", () => {
    const parsed = createPaymentSchema.safeParse(
      validPayment([
        {chainKey: "roax", token: "PLASMA", manualRate: "2500.00"},
        {chainKey: "roax", token: "RUSD"},
      ]),
    );
    expect(parsed.success).toBe(false);
  });
});
