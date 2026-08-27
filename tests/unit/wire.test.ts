import {describe, expect, it} from "vitest";
import {toPaymentPublicStatusResponse} from "@/lib/payments/wire";
import type {PaymentDoc, PaymentStatus} from "@/lib/models/Payment";

function fixturePayment(overrides: Partial<PaymentDoc> = {}): PaymentDoc {
  return {
    paymentId: "pay-1",
    invoiceNumber: "INV-000001",
    lineItems: [],
    currency: "USD",
    subtotal: "75.00",
    total: "75.00",
    status: "pending",
    crypto: [],
    receiptToken: "receipt-token-abc",
    viewToken: "view-token-abc",
    emailedTo: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PaymentDoc;
}

const BASE_URL = "https://vet.example";

describe("toPaymentPublicStatusResponse", () => {
  it("omits receiptUrl, chain, and txHash entirely for a pending payment", () => {
    const body = toPaymentPublicStatusResponse(fixturePayment({status: "pending"}), BASE_URL);
    expect(body.status).toBe("pending");
    expect(body.receiptAvailable).toBe(false);
    expect("receiptUrl" in body).toBe(false);
    expect("chain" in body).toBe(false);
    expect("txHash" in body).toBe(false);
  });

  it("includes receiptUrl, chain, and txHash for a payment matched on-chain by the watcher", () => {
    const payment = fixturePayment({
      status: "paid",
      paidWith: {
        chainKey: "baseSepolia",
        token: "USDC",
        txHash: "0xabc123",
        from: "0xdef456",
        amountBase: "75000123",
        blockNumber: 1000,
        confirmedAt: new Date(),
      },
    });
    const body = toPaymentPublicStatusResponse(payment, BASE_URL);

    expect(body.receiptAvailable).toBe(true);
    expect(body.receiptUrl).toBe(`${BASE_URL}/r/pay/receipt-token-abc`);
    expect(body.chain).toBe("base-sepolia");
    expect(body.txHash).toBe("0xabc123");
  });

  it("includes receiptUrl but omits chain and txHash for a manually-settled payment (no paidWith)", () => {
    const payment = fixturePayment({status: "paid", manualPaidNote: "Paid by check #204"});
    const body = toPaymentPublicStatusResponse(payment, BASE_URL);

    expect(body.receiptAvailable).toBe(true);
    expect(body.receiptUrl).toBe(`${BASE_URL}/r/pay/receipt-token-abc`);
    expect("chain" in body).toBe(false);
    expect("txHash" in body).toBe(false);
  });

  it("sets receiptAvailable exactly when status === paid, across every status", () => {
    const statuses: PaymentStatus[] = ["pending", "paid", "cancelled", "expired"];
    for (const status of statuses) {
      const body = toPaymentPublicStatusResponse(fixturePayment({status}), BASE_URL);
      expect(body.receiptAvailable).toBe(status === "paid");
      expect("receiptUrl" in body).toBe(status === "paid");
    }
  });

  it("never omits amount, currency, or status - the schema's required fields", () => {
    const body = toPaymentPublicStatusResponse(fixturePayment({total: "42.00", currency: "EUR"}), BASE_URL);
    expect(body.amount).toEqual({amount: "42.00", currency: "EUR"});
    expect(typeof body.status).toBe("string");
  });
});
