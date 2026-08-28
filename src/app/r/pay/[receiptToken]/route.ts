import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Payment, type PaymentDoc} from "@/lib/models/Payment";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {getBookingSettings} from "@/lib/models/Availability";
import {getServerEnv} from "@/lib/env";
import {enforceRateLimit, errorBody} from "@/lib/publicApi";
import {generateInvoicePdf} from "@/lib/payments/pdf";

/**
 * `GET /r/pay/{receiptToken}` - `vet-public-api.yaml`'s `downloadReceipt`, WIRE-AUTHORITATIVE:
 * returns the receipt PDF directly (`application/pdf`) when the token names a `paid` invoice, and
 * a 404 `Error` JSON body otherwise - "receiptToken unknown, or the payment has no receipt yet
 * (not paid)" is explicitly ONE case in the yaml, so an unpaid invoice and an unknown token are
 * deliberately indistinguishable from the response alone (never leaks which one it was).
 *
 * This is distinct from the public HTML status page at `/pay/{id}?token=...`
 * (`src/app/pay/[id]/page.tsx`), which DOES show status and offer a PDF download before payment -
 * that page downloads the (unstamped) invoice via the sibling `/pay/{id}/invoice`, a separate,
 * non-wire route; only the official post-payment receipt lives at this exact wire path, matching
 * qr-formats.md's "scanning it before that point returns 404" note on the receipt QR printed on
 * the invoice itself.
 */
export async function GET(request: Request, {params}: {params: Promise<{receiptToken: string}>}) {
  const rateLimit = enforceRateLimit(request, "receipt-download", 20, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const {receiptToken} = await params;
  await connectToDatabase();
  const payment = await Payment.findOne({receiptToken}).lean<PaymentDoc>();
  if (!payment || payment.status !== "paid") {
    return NextResponse.json(errorBody("not_found", "No receipt available for this token."), {
      status: 404,
      headers: rateLimit.headers,
    });
  }

  const [settings, bookingSettings, clientDoc] = await Promise.all([
    getClinicSettings(),
    getBookingSettings(),
    payment.clientId ? Client.findOne({clientId: payment.clientId}).lean<ClientDoc>() : Promise.resolve(null),
  ]);
  const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? new URL(request.url).origin;
  const pdf = await generateInvoicePdf({
    payment,
    businessProfile: settings.businessProfile,
    publicBaseUrl: baseUrl,
    timeZone: bookingSettings.timezone,
    stamped: true,
    client: clientDoc ? {name: clientDoc.name, email: clientDoc.email} : undefined,
  });

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      ...rateLimit.headers,
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="receipt-${payment.invoiceNumber}.pdf"`,
    },
  });
}
