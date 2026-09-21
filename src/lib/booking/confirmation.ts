import "server-only";
import {buildIcs, icsToBase64} from "@/lib/ics";
import {sendMail} from "@/lib/mailer";
import {formatUnixSeconds} from "@/lib/format";
import {getServerEnv} from "@/lib/env";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {getBookingSettings} from "@/lib/models/Availability";
import {Payment, type PaymentDoc} from "@/lib/models/Payment";
import type {AppointmentDoc} from "@/lib/models/Appointment";

/**
 * Builds the confirmation ics (used both as the client email attachment and the wire response's
 * base64 `ics` field) and fires the confirmation + clinic-notification emails - best-effort, per
 * `sendMail`'s contract: a mail failure never rolls back or fails the booking itself.
 *
 * WP4.18 V6 - the confirmation carries the invoice link "when one exists" (looked up by
 * `appointmentId`, the same link `Payment.appointmentId` uses everywhere else). DISCLOSED, not
 * hidden: this function has exactly ONE caller (`POST /v1/booking/book`), invoked immediately
 * after the appointment itself is created, so today's booking flow ("the clinic issues the
 * invoice, the client pays from the appointment screen or by scanning the QR" - plan section 4 -
 * an invoice is created by staff AFTER booking, never at booking time) means this lookup finds
 * nothing on a brand-new appointment in practice. It is still implemented (rather than skipped)
 * because it is cheap, unconditionally correct, and becomes live the moment either a future
 * deposit-at-booking wave (explicitly out of scope for WP4.18) or a booking made against an
 * appointmentId that already carries an invoice exists.
 */
export async function sendBookingConfirmation(params: {
  appointment: Pick<AppointmentDoc, "appointmentId" | "startAt" | "endAt" | "cancelToken">;
  serviceName: string;
  clientEmail: string;
  clientName: string;
  petName?: string;
  notes?: string;
}): Promise<string> {
  const env = getServerEnv();
  const [settings, bookingSettings, invoice] = await Promise.all([
    getClinicSettings(),
    getBookingSettings(),
    Payment.findOne({appointmentId: params.appointment.appointmentId}).sort({createdAt: -1}).lean<PaymentDoc>(),
  ]);
  const clinicName = settings.businessProfile?.name || "the clinic";

  const ics = buildIcs({
    uid: `${params.appointment.appointmentId}@dogtag-vet`,
    summary: `${params.serviceName} - ${clinicName}`,
    description: params.notes,
    startAt: params.appointment.startAt,
    endAt: params.appointment.endAt,
    status: "CONFIRMED",
  });
  const base64Ics = icsToBase64(ics);

  // A client-facing HTML page, not the wire-spec JSON endpoint (`/v1/booking/appointments/:id`) -
  // see `src/app/booking/[id]/page.tsx`'s doc comment for the split between the two.
  const manageUrl = env.PUBLIC_BASE_URL
    ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/booking/${params.appointment.appointmentId}?token=${params.appointment.cancelToken}`
    : undefined;
  // Same `/pay/{id}?token=...` link shape `pay/[id]/page.tsx` and `PaymentActions.tsx`'s "Copy
  // public link" already use, built from `Payment.viewToken` (see that model's own doc comment on
  // why this is the right token here, distinct from `receiptToken`).
  const invoiceUrl =
    invoice && env.PUBLIC_BASE_URL
      ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/pay/${invoice.paymentId}?token=${invoice.viewToken}`
      : undefined;

  const when = formatUnixSeconds(params.appointment.startAt, bookingSettings.timezone, true);
  const clientLines = [
    `Your appointment for ${params.petName ?? "your pet"} is confirmed.`,
    `Service: ${params.serviceName}`,
    `When: ${when}`,
    manageUrl ? `Manage or cancel this appointment: ${manageUrl}` : "",
    invoiceUrl ? `Invoice ${invoice!.invoiceNumber}: ${invoiceUrl}` : "",
  ].filter(Boolean);

  await sendMail({
    to: params.clientEmail,
    subject: `Appointment confirmed - ${clinicName}`,
    text: clientLines.join("\n"),
    attachments: [{filename: "appointment.ics", content: base64Ics, encoding: "base64", contentType: "text/calendar"}],
  });

  if (settings.businessProfile?.contactEmail) {
    await sendMail({
      to: settings.businessProfile.contactEmail,
      subject: `New booking - ${params.clientName}`,
      text: [
        `${params.clientName} booked ${params.serviceName}.`,
        `When: ${when}`,
        params.petName ? `Pet: ${params.petName}` : "",
        params.notes ? `Notes: ${params.notes}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  return base64Ics;
}
