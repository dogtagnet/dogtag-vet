import "server-only";
import {sendMail} from "@/lib/mailer";
import {generateInvoicePdf} from "@/lib/payments/pdf";
import type {PaymentDoc} from "@/lib/models/Payment";
import type {BusinessProfile} from "@/lib/models/ClinicSettings";
import {getServerEnv} from "@/lib/env";

function invoiceFilename(payment: PaymentDoc): string {
  return `invoice-${payment.invoiceNumber}.pdf`;
}

/** Emails the (possibly unpaid) invoice PDF to any address - the staff-triggered "email to any
 * address" feature. Also records the send in `Payment.emailedTo` (caller's responsibility, since
 * that write needs the live Mongoose document, not this pure send). */
export async function sendInvoiceEmail(
  payment: PaymentDoc,
  businessProfile: BusinessProfile | undefined,
  toEmail: string,
  timeZone: string,
): Promise<void> {
  const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? "";
  const pdf = await generateInvoicePdf({
    payment,
    businessProfile,
    publicBaseUrl: baseUrl,
    timeZone,
    stamped: payment.status === "paid",
  });
  await sendMail({
    to: toEmail,
    subject: `Invoice ${payment.invoiceNumber} from ${businessProfile?.name ?? "your vet"}`,
    text: `Invoice ${payment.invoiceNumber} - total ${payment.total} ${payment.currency}.\n\nThe invoice is attached as a PDF.`,
    attachments: [{filename: invoiceFilename(payment), content: pdf.toString("base64"), encoding: "base64", contentType: "application/pdf"}],
  });
}

/** Fires the paid-notification emails wp4-vet.md's watcher section describes: a receipt to the
 * client (if their email is on file) and a plain notice to the clinic's own contact address.
 * Best-effort - `sendMail` never throws, so a mail failure here never unwinds the payment's
 * already-committed `paid` status. */
export async function sendPaymentPaidEmails(
  payment: PaymentDoc,
  businessProfile: BusinessProfile | undefined,
  clientEmail: string | undefined,
  timeZone: string,
): Promise<void> {
  const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? "";

  if (clientEmail) {
    const pdf = await generateInvoicePdf({payment, businessProfile, publicBaseUrl: baseUrl, timeZone, stamped: true});
    await sendMail({
      to: clientEmail,
      subject: `Receipt for invoice ${payment.invoiceNumber}`,
      text: `Your payment of ${payment.total} ${payment.currency} for invoice ${payment.invoiceNumber} has been received. The receipt is attached.`,
      attachments: [
        {filename: invoiceFilename(payment), content: pdf.toString("base64"), encoding: "base64", contentType: "application/pdf"},
      ],
    });
  }

  if (businessProfile?.contactEmail) {
    await sendMail({
      to: businessProfile.contactEmail,
      subject: `Payment received - invoice ${payment.invoiceNumber}`,
      text: `Invoice ${payment.invoiceNumber} (${payment.total} ${payment.currency}) was marked paid.`,
    });
  }
}
