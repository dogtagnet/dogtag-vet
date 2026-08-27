import "server-only";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import type {CryptoRail, PaymentDoc} from "@/lib/models/Payment";
import type {BusinessProfile} from "@/lib/models/ClinicSettings";
import {formatUnixSeconds, truncateMiddle} from "@/lib/format";
import {explorerUrl} from "@/lib/explorer";
import {chainKeyToWireChain} from "@/lib/payments/wireChain";

/**
 * Print-medium colors mirroring design-system.md's light-theme token values. PDFKit has no CSS
 * variable concept to draw from, so this is the one place in the repo a hex literal is correct
 * outside `globals.css` - the values themselves are still sourced from that same token table, not
 * invented independently, and this comment is the paper trail for why this file is exempt from
 * the "no hardcoded hex outside the token file" rule.
 */
const PDF_COLOR = {
  ink: "#16202B",
  inkMuted: "#5B6773",
  border: "#D8DEE5",
  brand: "#0E6E63",
  ok: "#1F7A44",
};

export interface InvoicePdfInput {
  payment: PaymentDoc;
  businessProfile: BusinessProfile;
  publicBaseUrl: string;
  /** Whether to render the PAID stamp and paid-with details. Callers pass
   * `payment.status === "paid"` - kept as an explicit parameter rather than re-derived here so the
   * decision is visible at every call site. */
  stamped: boolean;
}

function money(amount: string, currency: string): string {
  return `${amount} ${currency}`;
}

/**
 * Renders the invoice PDF: clinic header, line items, totals, accepted crypto rails, and a receipt
 * QR linking `/r/pay/{receiptToken}` (per wp4-vet.md's payments section) - stamped PAID with a tx
 * link once `stamped` is true. Used by both the staff/public invoice-download route (any time) and
 * the wire-spec `GET /r/pay/{receiptToken}` route (always `stamped: true`, since that endpoint
 * only ever serves an already-paid invoice).
 */
export async function generateInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const {payment, businessProfile, publicBaseUrl, stamped} = input;
  const receiptUrl = `${publicBaseUrl.replace(/\/$/, "")}/r/pay/${payment.receiptToken}`;
  const qrPngBuffer = await QRCode.toBuffer(receiptUrl, {margin: 2, width: 200});

  const doc = new PDFDocument({size: "LETTER", margin: 50});
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  // Header
  doc.fillColor(PDF_COLOR.ink).fontSize(20).font("Helvetica-Bold").text(businessProfile.name ?? "Invoice");
  if (businessProfile.contactEmail) {
    doc.fillColor(PDF_COLOR.inkMuted).fontSize(10).font("Helvetica").text(businessProfile.contactEmail);
  }
  doc.moveDown(1);

  doc.fillColor(PDF_COLOR.ink).fontSize(16).font("Helvetica-Bold").text(`Invoice ${payment.invoiceNumber}`);
  doc.fillColor(PDF_COLOR.inkMuted).fontSize(10).font("Helvetica");
  doc.text(`Issued ${formatUnixSeconds(Math.floor(new Date(payment.createdAt).getTime() / 1000))}`);
  if (payment.dueAt) doc.text(`Due ${formatUnixSeconds(payment.dueAt)}`);

  if (stamped) {
    doc.moveDown(0.5);
    doc.fillColor(PDF_COLOR.ok).fontSize(14).font("Helvetica-Bold").text("PAID");
    if (payment.paidWith) {
      doc.fillColor(PDF_COLOR.inkMuted).fontSize(9).font("Helvetica");
      doc.text(`Transaction: ${payment.paidWith.txHash}`);
      const link = explorerUrl(payment.paidWith.chainKey, "tx", payment.paidWith.txHash);
      if (link) doc.fillColor(PDF_COLOR.brand).text(link, {link});
    } else if (payment.manualPaidNote) {
      doc.fillColor(PDF_COLOR.inkMuted).fontSize(9).font("Helvetica").text(`Marked paid: ${payment.manualPaidNote}`);
    }
  }
  doc.moveDown(1);

  // Line items table
  doc.fillColor(PDF_COLOR.ink).fontSize(11).font("Helvetica-Bold");
  const colX = {desc: 50, qty: 320, unit: 380, amount: 470};
  doc.text("Description", colX.desc, doc.y, {continued: false});
  doc.text("Qty", colX.qty, doc.y - doc.currentLineHeight());
  doc.text("Unit", colX.unit, doc.y - doc.currentLineHeight());
  doc.text("Amount", colX.amount, doc.y - doc.currentLineHeight());
  doc.moveTo(50, doc.y + 2).lineTo(562, doc.y + 2).strokeColor(PDF_COLOR.border).stroke();
  doc.moveDown(0.5);

  doc.font("Helvetica").fontSize(10).fillColor(PDF_COLOR.ink);
  for (const item of payment.lineItems) {
    const rowY = doc.y;
    doc.text(item.description, colX.desc, rowY, {width: 260});
    doc.text(String(item.qty), colX.qty, rowY);
    doc.text(item.unitAmount, colX.unit, rowY);
    doc.text(item.amount, colX.amount, rowY);
    doc.moveDown(0.75);
  }

  doc.moveTo(50, doc.y + 4).lineTo(562, doc.y + 4).strokeColor(PDF_COLOR.border).stroke();
  doc.moveDown(0.75);

  doc.font("Helvetica").fontSize(10).fillColor(PDF_COLOR.inkMuted);
  doc.text(`Subtotal: ${money(payment.subtotal, payment.currency)}`, {align: "right"});
  if (payment.tax) {
    doc.text(`${payment.tax.label} (${payment.tax.rate}): ${money(payment.tax.amount, payment.currency)}`, {
      align: "right",
    });
  }
  doc.font("Helvetica-Bold").fontSize(12).fillColor(PDF_COLOR.ink);
  doc.text(`Total: ${money(payment.total, payment.currency)}`, {align: "right"});
  doc.moveDown(1);

  // Accepted crypto rails
  if (payment.crypto.length > 0) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor(PDF_COLOR.ink).text("Accepted crypto payment rails");
    doc.font("Helvetica").fontSize(9).fillColor(PDF_COLOR.inkMuted);
    for (const rail of payment.crypto as CryptoRail[]) {
      doc.text(
        `${chainKeyToWireChain(rail.chainKey)} - ${rail.token}: ${rail.amountBase} base units to ${truncateMiddle(rail.receivingAddress)} (rate ${rail.quotedRate} ${payment.currency}/${rail.token})`,
      );
    }
    doc.moveDown(1);
  }

  // Receipt QR
  doc.font("Helvetica-Bold").fontSize(10).fillColor(PDF_COLOR.ink).text("Scan to view this receipt");
  doc.image(qrPngBuffer, 50, doc.y + 6, {width: 100, height: 100});

  doc.end();
  return done;
}
