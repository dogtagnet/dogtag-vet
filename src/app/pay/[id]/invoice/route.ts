import {NextResponse} from "next/server";
import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {Payment, type PaymentDoc} from "@/lib/models/Payment";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {getBookingSettings} from "@/lib/models/Availability";
import {getServerEnv} from "@/lib/env";
import {generateInvoicePdf} from "@/lib/payments/pdf";
import {enforceRateLimit} from "@/lib/publicApi";

/**
 * `GET /pay/{id}/invoice?token=...` - downloads the invoice PDF. Not part of `vet-public-api.yaml`
 * (that spec's only PDF endpoint is the paid-only `GET /r/pay/{receiptToken}`); this route backs
 * both the staff detail page's "Download invoice" button (session auth) and the public `/pay/{id}`
 * page's equivalent link for a client who has not paid yet and so has no receipt token (`?token=`,
 * checked against the payment's `viewToken`) - it renders the SAME PDF either way, stamped PAID
 * once the payment is.
 *
 * Deliberately placed under `/pay/` rather than `/api/payments/`: `src/auth.config.ts`'s edge
 * middleware gates everything behind sign-in EXCEPT a fixed list of public path prefixes, and
 * `/pay/` is one of them (added alongside the public payment page itself) - a route needing to
 * answer an anonymous request with nothing but a `?token=` query param must live under a prefix
 * middleware already treats as public, or the edge redirect to `/sign-in` happens before this
 * handler's own session-or-token check ever runs. `/api/payments/` is NOT public (by design - it
 * is where the staff-only mutation routes live), so this could not stay there once it needed to
 * serve anonymous requests.
 *
 * Rate-limited the same as `/r/pay/{receiptToken}`: the `?token=` path is reachable with no staff
 * session, and PDF generation is not free to run per request.
 */
export async function GET(request: Request, {params}: {params: Promise<{id: string}>}) {
  const rateLimit = enforceRateLimit(request, "invoice-download", 20, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const {id} = await params;
  const token = new URL(request.url).searchParams.get("token");

  await connectToDatabase();
  const payment = await Payment.findOne({paymentId: id}).lean<PaymentDoc>();
  if (!payment) {
    return NextResponse.json({error: {code: "not_found", message: "Payment not found."}}, {status: 404, headers: rateLimit.headers});
  }

  const session = await auth();
  const authorized = Boolean(session?.user) || (token !== null && token === payment.viewToken);
  if (!authorized) {
    return NextResponse.json(
      {error: {code: "unauthorized", message: "Sign in, or supply a valid token."}},
      {status: 401, headers: rateLimit.headers},
    );
  }

  const [settings, bookingSettings] = await Promise.all([getClinicSettings(), getBookingSettings()]);
  const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? new URL(request.url).origin;
  const pdf = await generateInvoicePdf({
    payment,
    businessProfile: settings.businessProfile,
    publicBaseUrl: baseUrl,
    timeZone: bookingSettings.timezone,
    stamped: payment.status === "paid",
  });

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      ...rateLimit.headers,
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="invoice-${payment.invoiceNumber}.pdf"`,
    },
  });
}
