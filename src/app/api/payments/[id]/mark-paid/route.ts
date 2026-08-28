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
  await sendPaymentPaidEmails(updated, settings.businessProfile, client?.email, bookingSettings.timezone);

  return NextResponse.json(updated);
}
