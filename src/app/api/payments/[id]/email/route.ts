import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Payment, type PaymentDoc} from "@/lib/models/Payment";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {emailPaymentSchema} from "@/lib/schemas/payment";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";
import {sendInvoiceEmail} from "@/lib/payments/emails";

/** `POST /api/payments/{id}/email {email}` - staff-only "email to any address" (wp4-vet.md). */
export async function POST(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  const body = await request.json().catch(() => null);
  const parsed = emailPaymentSchema.safeParse(body);
  if (!parsed.success) return badRequest("A valid email address is required.", parsed.error.flatten());

  await connectToDatabase();
  const payment = await Payment.findOne({paymentId: id}).lean<PaymentDoc>();
  if (!payment) return notFound("Payment not found.");

  const settings = await getClinicSettings();
  await sendInvoiceEmail(payment, settings.businessProfile, parsed.data.email);
  await Payment.updateOne({paymentId: id}, {$push: {emailedTo: {email: parsed.data.email, at: new Date()}}});

  return NextResponse.json({ok: true});
}
