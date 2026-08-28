import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {getBookingSettings} from "@/lib/models/Availability";
import {markPaidSchema} from "@/lib/schemas/payment";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";
import {markPaymentPaidManually} from "@/lib/payments/markPaid";
import {sendPaymentPaidEmails} from "@/lib/payments/emails";

/** `POST /api/payments/{id}/mark-paid` - staff-only manual settlement (cash, check, in person).
 * Never writes a `paidWith` - see `markPaid.ts`'s doc comment for why that field is reserved for a
 * real on-chain match. */
export async function POST(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  const body = await request.json().catch(() => null);
  const parsed = markPaidSchema.safeParse(body);
  if (!parsed.success) return badRequest("A note is required.", parsed.error.flatten());

  await connectToDatabase();
  const updated = await markPaymentPaidManually(id, parsed.data.note);
  if (!updated) return notFound("Payment not found or not pending.");

  const [settings, bookingSettings, client] = await Promise.all([
    getClinicSettings(),
    getBookingSettings(),
    updated.clientId ? Client.findOne({clientId: updated.clientId}).lean<ClientDoc>() : Promise.resolve(null),
  ]);
  // Best-effort, deliberately outside the mutation above: the payment is already durably marked
  // paid, so a failure rendering/sending the follow-up email (a PDF-generation bug, a malformed
  // business profile, an SMTP outage) must never turn a successful operator action into a 500 -
  // that would tell the operator the mark-paid failed when it did not. Mirrors sendMail's own
  // "never throws" contract one level up, for the one step (PDF generation) that isn't sendMail.
  try {
    await sendPaymentPaidEmails(updated, settings.businessProfile, client?.email, bookingSettings.timezone);
  } catch (err) {
    console.error(`[mark-paid] payment ${updated.paymentId} marked paid but notification email failed:`, err);
  }

  return NextResponse.json(updated);
}
