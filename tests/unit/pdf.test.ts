import {describe, expect, it} from "vitest";
import {PDFParse} from "pdf-parse";
import {generateInvoicePdf} from "@/lib/payments/pdf";
import type {PaymentDoc} from "@/lib/models/Payment";

const TIME_ZONE = "America/New_York";

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

/** Extracts every text item's string plus its page position, so a test can assert *where* a run
 * of text landed (same line as another, or near the bottom of the page) rather than only which
 * words appear somewhere in the document - the class of defect round 2 flagged (a caption on one
 * side of the page, its QR on the other) is invisible to a plain text-content check. */
async function extractPage1Items(pdf: Buffer) {
  const parser = new PDFParse({data: new Uint8Array(pdf)});
  try {
    const result = await parser.getText();
    return result.pages[0]!;
  } finally {
    await parser.destroy();
  }
}

describe("generateInvoicePdf", () => {
  it("produces a real, non-trivial PDF buffer", async () => {
    const pdf = await generateInvoicePdf({
      payment: fixturePayment(),
      businessProfile: {name: "Riverside Vet Clinic", contactEmail: "hello@riverside.example"},
      publicBaseUrl: "https://vet.example",
      timeZone: TIME_ZONE,
      stamped: false,
    });

    // A build passing (pdfkit compiles fine) is not proof a PDF actually renders at request time -
    // pdfkit loads its .afm font metrics from disk lazily, which can fail post-build under a
    // bundler that mishandles the package (see next.config.ts's serverExternalPackages comment).
    // This assertion is the one that would actually catch that.
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(3000);
  });

  it("keeps the totals block on the page's full width - a currency code never wraps onto its own line", async () => {
    const pdf = await generateInvoicePdf({
      payment: fixturePayment({
        lineItems: [{description: "Wellness exam", qty: 1, unitAmount: "210.00", amount: "210.00"}],
        subtotal: "210.00",
        total: "210.00",
      }),
      businessProfile: {name: "Riverside Vet Clinic"},
      publicBaseUrl: "https://vet.example",
      timeZone: TIME_ZONE,
      stamped: false,
    });

    const page = await extractPage1Items(pdf);
    expect(page.text).toMatch(/Subtotal: 210\.00 USD/);
    expect(page.text).toMatch(/Total: 210\.00 USD/);
    // Neither total line's "USD" landed on a line by itself, separated from its amount - the
    // previously-reported defect (a stale narrow `x` inherited from the line-items table made
    // `align: "right"` compute a ~90pt available width, wrapping the currency code alone).
    expect(page.text).not.toMatch(/^\s*USD\s*$/m);
  });

  it("renders a PAID stamp and a single, middle-truncated transaction reference - never the raw hash plus a second untruncated URL", async () => {
    const txHash = "0x" + "ab".repeat(32);
    const pdf = await generateInvoicePdf({
      payment: fixturePayment({
        status: "paid",
        crypto: [
          {
            chainKey: "sepolia",
            token: "ETH",
            decimals: 18,
            quotedRate: "3000.00",
            amountBase: "1000000000000000",
            receivingAddress: "0x" + "11".repeat(20),
            eip681: "ethereum:0x0",
          },
        ],
        paidWith: {
          chainKey: "base",
          token: "USDC",
          txHash,
          from: "0xdef456",
          amountBase: "75000000",
          blockNumber: 1000,
          confirmedAt: new Date(),
        },
      }),
      businessProfile: {name: "Riverside Vet Clinic"},
      publicBaseUrl: "https://vet.example",
      timeZone: TIME_ZONE,
      stamped: true,
    });

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const page = await extractPage1Items(pdf);
    expect(page.text).toContain("PAID");
    // The full, untruncated hash appears nowhere in the rendered text - only the middle-truncated
    // form (which may carry a link annotation, checked below, but the visible text is truncated).
    expect(page.text).not.toContain(txHash);
    expect(page.text).toMatch(/0xabab...abab/);
    // A stamped (already-paid) receipt drops the accepted-rails list entirely - it is no longer a
    // request for payment, so a testnet rail has no business appearing on it.
    expect(page.text).not.toMatch(/testnet/i);
    expect(page.text).not.toContain("Accepted crypto payment rails");
  });

  it("renders a manual-paid note without a paidWith block", async () => {
    const pdf = await generateInvoicePdf({
      payment: fixturePayment({status: "paid", manualPaidNote: "Paid by check #204"}),
      businessProfile: {name: "Riverside Vet Clinic"},
      publicBaseUrl: "https://vet.example",
      timeZone: TIME_ZONE,
      stamped: true,
    });

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const page = await extractPage1Items(pdf);
    expect(page.text).toContain("Marked paid: Paid by check #204");
  });

  it("shows accepted crypto rails as an exact human-readable token amount, never raw base units, and marks testnets", async () => {
    const pdf = await generateInvoicePdf({
      payment: fixturePayment({
        crypto: [
          {
            chainKey: "sepolia",
            token: "ETH",
            decimals: 18,
            quotedRate: "3000.00",
            amountBase: "41436327650000237",
            receivingAddress: "0x" + "22".repeat(20),
            eip681: "ethereum:0x0",
          },
        ],
      }),
      businessProfile: {name: "Riverside Vet Clinic"},
      publicBaseUrl: "https://vet.example",
      timeZone: TIME_ZONE,
      stamped: false,
    });

    const page = await extractPage1Items(pdf);
    expect(page.text).toContain("0.041436327650000237 ETH");
    expect(page.text).not.toContain("41436327650000237 base units");
    expect(page.text).toMatch(/sepolia.*\(testnet\)/i);
  });

  it("renders without a configured business profile - a fresh, never-configured deployment's default state", async () => {
    // Regression test for the round-4 finding: `ClinicSettings.businessProfile` had no schema
    // default, so `getClinicSettings()` returned it as `undefined` on any deployment whose
    // business profile had never been touched, and every PDF path (including the wire-authoritative
    // `GET /r/pay/{receiptToken}`) 500'd dereferencing `.name` off it. Passing `undefined` here
    // exercises `generateInvoicePdf`'s own defensive default directly, independent of whether the
    // ClinicSettings-layer fix is also in place.
    const pdf = await generateInvoicePdf({
      payment: fixturePayment(),
      businessProfile: undefined,
      publicBaseUrl: "https://vet.example",
      timeZone: TIME_ZONE,
      stamped: false,
    });

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const page = await extractPage1Items(pdf);
    expect(page.text).toContain("Invoice");
  });

  it("prints the QR caption as the last text on the page, immediately followed by the code itself", async () => {
    const pdf = await generateInvoicePdf({
      payment: fixturePayment(),
      businessProfile: {name: "Riverside Vet Clinic"},
      publicBaseUrl: "https://vet.example",
      timeZone: TIME_ZONE,
      stamped: false,
    });

    const page = await extractPage1Items(pdf);
    // Nothing is drawn after the caption except the QR image itself (no text), so in reading
    // order the caption is the last line - the previously-reported defect had the caption written
    // from wherever an unrelated block above (the rails loop) had left the cursor, nowhere near the
    // QR image actually printed at the page's bottom-left.
    expect(page.text.trim().endsWith("Scan to view this invoice online")).toBe(true);

    const image = await new PDFParse({data: new Uint8Array(pdf)}).getImage({partial: [1]});
    expect(image.pages[0]?.images?.length).toBeGreaterThan(0);
  });

  it("never prints the paid-only receipt URL as a scannable code on an unpaid invoice - it 404s by design until paid (qr-formats.md)", async () => {
    const pdf = await generateInvoicePdf({
      payment: fixturePayment({receiptToken: "receipt-token-abc", viewToken: "view-token-abc", paymentId: "pay-1"}),
      businessProfile: {name: "Riverside Vet Clinic"},
      publicBaseUrl: "https://vet.example",
      timeZone: TIME_ZONE,
      stamped: false,
    });

    const page = await extractPage1Items(pdf);
    expect(page.text).toContain("Scan to view this invoice online");
    expect(page.text).not.toContain("Scan to view this receipt");

    const image = await new PDFParse({data: new Uint8Array(pdf)}).getImage({partial: [1]});
    const items = image.pages[0]?.images ?? [];
    expect(items.length).toBeGreaterThan(0);
  });

  it("prints the wire-authoritative receipt URL as the QR once stamped paid", async () => {
    const pdf = await generateInvoicePdf({
      payment: fixturePayment({status: "paid"}),
      businessProfile: {name: "Riverside Vet Clinic"},
      publicBaseUrl: "https://vet.example",
      timeZone: TIME_ZONE,
      stamped: true,
    });

    const page = await extractPage1Items(pdf);
    expect(page.text).toContain("Scan to view this receipt");
    expect(page.text).not.toContain("Scan to view this invoice online");
  });

  it("prints the accepted rail's human-facing chain name, never the internal chain key or its wire kebab-case form", async () => {
    const pdf = await generateInvoicePdf({
      payment: fixturePayment({
        crypto: [
          {
            chainKey: "baseSepolia",
            token: "USDC",
            decimals: 6,
            quotedRate: "1.00",
            amountBase: "388786001",
            receivingAddress: "0x" + "33".repeat(20),
            eip681: "ethereum:0x0",
          },
        ],
      }),
      businessProfile: {name: "Riverside Vet Clinic"},
      publicBaseUrl: "https://vet.example",
      timeZone: TIME_ZONE,
      stamped: false,
    });

    const page = await extractPage1Items(pdf);
    expect(page.text).toContain("Base Sepolia (testnet)");
    expect(page.text).not.toContain("baseSepolia");
    expect(page.text).not.toContain("base-sepolia");
  });

  it("renders a clinic postal address and a bill-to block when supplied", async () => {
    const pdf = await generateInvoicePdf({
      payment: fixturePayment({clientId: "client-1"}),
      businessProfile: {
        name: "Riverside Vet Clinic",
        contactEmail: "hello@riverside.example",
        address: {line1: "1180 Bayfront Avenue", city: "San Francisco", region: "CA", postalCode: "94107", country: "US"},
      },
      publicBaseUrl: "https://vet.example",
      timeZone: TIME_ZONE,
      stamped: false,
      client: {name: "Jordan Alvarez", email: "jordan@example.com"},
    });

    const page = await extractPage1Items(pdf);
    expect(page.text).toContain("1180 Bayfront Avenue");
    expect(page.text).toContain("San Francisco, CA 94107");
    expect(page.text).toContain("US");
    expect(page.text).toContain("Bill to");
    expect(page.text).toContain("Jordan Alvarez");
    expect(page.text).toContain("jordan@example.com");
  });

  it("omits the bill-to block for a client-less payment rather than rendering it empty", async () => {
    const pdf = await generateInvoicePdf({
      payment: fixturePayment(),
      businessProfile: {name: "Riverside Vet Clinic"},
      publicBaseUrl: "https://vet.example",
      timeZone: TIME_ZONE,
      stamped: false,
    });

    const page = await extractPage1Items(pdf);
    expect(page.text).not.toContain("Bill to");
  });

  it("falls back to a text-only header when the configured logo URL is unreachable, rather than failing invoice generation", async () => {
    const pdf = await generateInvoicePdf({
      payment: fixturePayment(),
      businessProfile: {name: "Riverside Vet Clinic", logoUrl: "https://logo.invalid/does-not-resolve.png"},
      publicBaseUrl: "https://vet.example",
      timeZone: TIME_ZONE,
      stamped: false,
    });

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const page = await extractPage1Items(pdf);
    expect(page.text).toContain("Riverside Vet Clinic");
  });
});
