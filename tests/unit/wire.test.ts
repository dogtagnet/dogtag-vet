import {describe, expect, it} from "vitest";
import {toPaymentPublicStatusResponse} from "@/lib/payments/wire";
import type {CryptoRail, PaymentDoc, PaymentStatus} from "@/lib/models/Payment";

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

function fixtureRail(overrides: Partial<CryptoRail> = {}): CryptoRail {
  return {
    chainKey: "roax",
    token: "PLASMA",
    decimals: 18,
    quotedRate: "3000.00",
    amountBase: "25000000000000000",
    receivingAddress: "0x" + "22".repeat(20),
    eip681: "ethereum:0x0",
    ...overrides,
  };
}

const BASE_URL = "https://vet.example";
const CHAIN_ID = 135;
const CONFIRMATIONS = 2;

describe("toPaymentPublicStatusResponse", () => {
  it("omits receiptUrl, chain, chainId, and txHash entirely for a pending payment with no crypto rails", () => {
    const body = toPaymentPublicStatusResponse(fixturePayment({status: "pending"}), BASE_URL, CHAIN_ID, CONFIRMATIONS);
    expect(body.status).toBe("pending");
    expect(body.receiptAvailable).toBe(false);
    expect("receiptUrl" in body).toBe(false);
    expect("chain" in body).toBe(false);
    expect("chainId" in body).toBe(false);
    expect("txHash" in body).toBe(false);
    expect("rails" in body).toBe(false);
  });

  it("includes receiptUrl, chain, chainId, and txHash for a payment matched on-chain by the watcher", () => {
    const payment = fixturePayment({
      status: "paid",
      paidWith: {
        chainKey: "roax",
        token: "RUSD",
        txHash: "0xabc123",
        from: "0xdef456",
        amountBase: "75000123",
        blockNumber: 1000,
        confirmedAt: new Date(),
      },
    });
    const body = toPaymentPublicStatusResponse(payment, BASE_URL, CHAIN_ID, CONFIRMATIONS);

    expect(body.receiptAvailable).toBe(true);
    expect(body.receiptUrl).toBe(`${BASE_URL}/r/pay/receipt-token-abc`);
    expect(body.chain).toBe("roax");
    expect(body.chainId).toBe(CHAIN_ID);
    expect(body.txHash).toBe("0xabc123");
  });

  it("includes receiptUrl but omits chain, chainId, and txHash for a manually-settled payment (no paidWith)", () => {
    const payment = fixturePayment({status: "paid", manualPaidNote: "Paid by check #204"});
    const body = toPaymentPublicStatusResponse(payment, BASE_URL, CHAIN_ID, CONFIRMATIONS);

    expect(body.receiptAvailable).toBe(true);
    expect(body.receiptUrl).toBe(`${BASE_URL}/r/pay/receipt-token-abc`);
    expect("chain" in body).toBe(false);
    expect("chainId" in body).toBe(false);
    expect("txHash" in body).toBe(false);
  });

  it("sets receiptAvailable exactly when status === paid, across every status", () => {
    const statuses: PaymentStatus[] = ["pending", "paid", "cancelled", "expired"];
    for (const status of statuses) {
      const body = toPaymentPublicStatusResponse(fixturePayment({status}), BASE_URL, CHAIN_ID, CONFIRMATIONS);
      expect(body.receiptAvailable).toBe(status === "paid");
      expect("receiptUrl" in body).toBe(status === "paid");
    }
  });

  it("never omits amount, currency, status, or confirmationsRequired - the schema's required fields", () => {
    const body = toPaymentPublicStatusResponse(fixturePayment({total: "42.00", currency: "EUR"}), BASE_URL, CHAIN_ID, CONFIRMATIONS);
    expect(body.amount).toEqual({amount: "42.00", currency: "EUR"});
    expect(typeof body.status).toBe("string");
    expect(body.confirmationsRequired).toBe(CONFIRMATIONS);
  });

  // WP4.18 V6 - the phone fetches this endpoint per linked invoice and needs the fiat amount
  // (top-level `amount`, already covered above), the token amount, the token symbol, the chain
  // id, the receiving address, the EIP-681 request, and the status to offer Pay.
  describe("rails", () => {
    it("includes one entry per open crypto rail - both PLASMA and RUSD at once - while pending", () => {
      const payment = fixturePayment({
        status: "pending",
        crypto: [
          fixtureRail({token: "PLASMA", amountBase: "25000000000000000", decimals: 18}),
          fixtureRail({token: "RUSD", amountBase: "42500000", decimals: 6, receivingAddress: "0x" + "33".repeat(20), eip681: "ethereum:0x1"}),
        ],
      });
      const body = toPaymentPublicStatusResponse(payment, BASE_URL, CHAIN_ID, CONFIRMATIONS);

      expect(body.rails).toEqual([
        {
          tokenSymbol: "PLASMA",
          tokenAmount: "0.025", // exact human decimal, formatUnits(25000000000000000n, 18)
          chainId: CHAIN_ID,
          receivingAddress: "0x" + "22".repeat(20),
          eip681: "ethereum:0x0",
        },
        {
          tokenSymbol: "RUSD",
          tokenAmount: "42.5", // formatUnits(42500000n, 6)
          chainId: CHAIN_ID,
          receivingAddress: "0x" + "33".repeat(20),
          eip681: "ethereum:0x1",
        },
      ]);
    });

    it("omits rails entirely once paid - nothing is left to pay", () => {
      const payment = fixturePayment({status: "paid", crypto: [fixtureRail()], paidWith: undefined, manualPaidNote: "cash"});
      const body = toPaymentPublicStatusResponse(payment, BASE_URL, CHAIN_ID, CONFIRMATIONS);
      expect("rails" in body).toBe(false);
    });

    it("omits rails for a cancelled or expired payment too - not just paid", () => {
      for (const status of ["cancelled", "expired"] as const) {
        const body = toPaymentPublicStatusResponse(fixturePayment({status, crypto: [fixtureRail()]}), BASE_URL, CHAIN_ID, CONFIRMATIONS);
        expect("rails" in body).toBe(false);
      }
    });

    it("omits rails when pending but no crypto rail was ever built", () => {
      const body = toPaymentPublicStatusResponse(fixturePayment({status: "pending", crypto: []}), BASE_URL, CHAIN_ID, CONFIRMATIONS);
      expect("rails" in body).toBe(false);
    });
  });

  // Cross-repo wire contract ruling (after the ios/specs waves reviewed this response shape):
  // confirmationsRequired is always present; expiresAt is present iff dueAt is set.
  describe("confirmationsRequired and expiresAt", () => {
    it("carries confirmationsRequired unconditionally, across every status", () => {
      const statuses: PaymentStatus[] = ["pending", "paid", "cancelled", "expired"];
      for (const status of statuses) {
        const body = toPaymentPublicStatusResponse(fixturePayment({status}), BASE_URL, CHAIN_ID, 3);
        expect(body.confirmationsRequired).toBe(3);
      }
    });

    it("omits expiresAt when the invoice has no due date", () => {
      const body = toPaymentPublicStatusResponse(fixturePayment({dueAt: undefined}), BASE_URL, CHAIN_ID, CONFIRMATIONS);
      expect("expiresAt" in body).toBe(false);
    });

    it("includes expiresAt as an ISO 8601 string derived from dueAt when set", () => {
      const dueAt = 1_800_000_000; // an arbitrary fixed unix-seconds instant
      const body = toPaymentPublicStatusResponse(fixturePayment({dueAt}), BASE_URL, CHAIN_ID, CONFIRMATIONS);
      expect(body.expiresAt).toBe(new Date(dueAt * 1000).toISOString());
    });
  });
});
