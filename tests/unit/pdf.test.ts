import {describe, expect, it} from "vitest";
import {generateInvoicePdf} from "@/lib/payments/pdf";
import type {PaymentDoc} from "@/lib/models/Payment";

function fixturePayment(overrides: Partial<PaymentDoc> = {}): PaymentDoc {
  return {
    paymentId: "pay-1",
    invoiceNumber: "INV-000001",
    lineItems: [{description: "Wellness exam", qty: 1, unitAmount: "75.00", amount: "75.00"}],
    currency: "USD",
    subtotal: "75.00",
    total: "75.00",
    status: "pending",
    crypto: [],
    receiptToken: "receipt-token-abc",
    viewToken: "view-token-abc",
    emailedTo: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as PaymentDoc;
}

describe("generateInvoicePdf", () => {
  it("produces a real, non-trivial PDF buffer", async () => {
    const pdf = await generateInvoicePdf({
      payment: fixturePayment(),
      businessProfile: {name: "Riverside Vet Clinic", contactEmail: "hello@riverside.example"},
      publicBaseUrl: "https://vet.example",
      stamped: false,
    });

    // A build passing (pdfkit compiles fine) is not proof a PDF actually renders at request time -
    // pdfkit loads its .afm font metrics from disk lazily, which can fail post-build under a
    // bundler that mishandles the package (see next.config.ts's serverExternalPackages comment).
    // This assertion is the one that would actually catch that.
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(3000);
  });

  it("renders a PAID stamp and transaction hash when stamped with an on-chain paidWith", async () => {
    const pdf = await generateInvoicePdf({
      payment: fixturePayment({
        status: "paid",
        paidWith: {
          chainKey: "base",
          token: "USDC",
          txHash: "0xabc123",
          from: "0xdef456",
          amountBase: "75000000",
          blockNumber: 1000,
          confirmedAt: new Date(),
        },
      }),
      businessProfile: {name: "Riverside Vet Clinic"},
      publicBaseUrl: "https://vet.example",
      stamped: true,
    });

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(3000);
  });

  it("renders a manual-paid note without a paidWith block", async () => {
    const pdf = await generateInvoicePdf({
      payment: fixturePayment({status: "paid", manualPaidNote: "Paid by check #204"}),
      businessProfile: {name: "Riverside Vet Clinic"},
      publicBaseUrl: "https://vet.example",
      stamped: true,
    });

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });
});
