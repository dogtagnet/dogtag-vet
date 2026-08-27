import "server-only";
import {buildIcs, icsToBase64} from "@/lib/ics";
import {sendMail} from "@/lib/mailer";
import {getServerEnv} from "@/lib/env";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import type {AppointmentDoc} from "@/lib/models/Appointment";

/** Builds the confirmation ics (used both as the client email attachment and the wire response's
 * base64 `ics` field) and fires the confirmation + clinic-notification emails - best-effort, per
 * `sendMail`'s contract: a mail failure never rolls back or fails the booking itself. */
export async function sendBookingConfirmation(params: {
  appointment: Pick<AppointmentDoc, "appointmentId" | "startAt" | "endAt" | "cancelToken">;
  serviceName: string;
  clientEmail: string;
  clientName: string;
  petName?: string;
  notes?: string;
}): Promise<string> {
  const env = getServerEnv();
  const settings = await getClinicSettings();
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

  const manageUrl = env.PUBLIC_BASE_URL
    ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/v1/booking/appointments/${params.appointment.appointmentId}?token=${params.appointment.cancelToken}`
    : undefined;

  const when = new Date(params.appointment.startAt * 1000).toUTCString();
  const clientLines = [
    `Your appointment for ${params.petName ?? "your pet"} is confirmed.`,
    `Service: ${params.serviceName}`,
    `When: ${when}`,
    manageUrl ? `Manage or cancel this appointment: ${manageUrl}` : "",
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
