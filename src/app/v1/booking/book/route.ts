import {randomBytes} from "node:crypto";
import {createAppointment} from "@/lib/booking/lifecycle";
import {loadAvailabilityConfig} from "@/lib/booking/queries";
import {findOrCreateClientForBooking} from "@/lib/booking/clientMatch";
import {sendBookingConfirmation} from "@/lib/booking/confirmation";
import {toPublicAppointmentStatus} from "@/lib/booking/status";
import {connectToDatabase} from "@/lib/db";
import type {AppointmentDraft} from "@/lib/booking/mongoStore";
import {Service, type ServiceDoc} from "@/lib/models/Service";
import {bookAppointmentRequestSchema} from "@/lib/schemas/booking";
import {enforceRateLimit, errorBody, jsonWithHeaders, readJsonBody} from "@/lib/publicApi";

/**
 * `POST /v1/booking/book` - `vet-public-api.yaml`. This build has no staff-approval step: a
 * successful booking is confirmed immediately (email + ics sent right away), so the response
 * status is always `confirmed` (see `toPublicAppointmentStatus`'s doc comment) and `ics` is
 * always present.
 */
export async function POST(request: Request) {
  const rateLimit = enforceRateLimit(request, "booking-book", 10, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  // `vet-public-api.yaml` documents only 400/409/429/5XX for this route (no 413), so an oversized
  // body is reported the same way as any other malformed request rather than introducing a status
  // code the wire contract does not define.
  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return jsonWithHeaders(
      errorBody("invalid_input", parsedBody.tooLarge ? "Request body is too large." : "Malformed booking request."),
      {status: 400, headers: rateLimit.headers},
    );
  }
  const parsed = bookAppointmentRequestSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return jsonWithHeaders(errorBody("invalid_input", "Malformed booking request.", parsed.error.flatten()), {
      status: 400,
      headers: rateLimit.headers,
    });
  }

  const startAtMs = Date.parse(parsed.data.startAt);
  if (Number.isNaN(startAtMs)) {
    return jsonWithHeaders(errorBody("invalid_input", "startAt must be an ISO 8601 instant."), {
      status: 400,
      headers: rateLimit.headers,
    });
  }
  const startAt = Math.floor(startAtMs / 1000);

  await connectToDatabase();
  const service = await Service.findOne({
    serviceId: parsed.data.serviceId,
    active: true,
    bookableOnline: true,
  }).lean<ServiceDoc>();
  if (!service) {
    return jsonWithHeaders(errorBody("service_not_found", "Unknown or unbookable service."), {
      status: 400,
      headers: rateLimit.headers,
    });
  }
  const endAt = startAt + service.durationMinutes * 60;

  const config = await loadAvailabilityConfig();
  const now = Math.floor(Date.now() / 1000);
  if (startAt < now + config.settings.minNoticeMinutes * 60) {
    return jsonWithHeaders(errorBody("invalid_input", "This time no longer meets the minimum notice."), {
      status: 400,
      headers: rateLimit.headers,
    });
  }
  if (startAt > now + config.settings.maxAdvanceDays * 86400) {
    return jsonWithHeaders(errorBody("invalid_input", "This time is beyond the booking horizon."), {
      status: 400,
      headers: rateLimit.headers,
    });
  }

  const client = await findOrCreateClientForBooking(parsed.data.client);
  const cancelToken = randomBytes(16).toString("hex");
  // Appointment.petName is required and non-blank per the v1 field vocabulary (wp4-vet.md) - and
  // mongoose's default String required-check rejects "" - but the wire request's petName is
  // optional, so fall back to a display placeholder rather than leaving it blank.
  const petName = parsed.data.petName?.trim() || "Pet";

  const draft: AppointmentDraft = {
    clientId: client.clientId,
    serviceId: service.serviceId,
    startAt,
    endAt,
    notes: parsed.data.notes,
    source: "public_booking",
    clientName: client.name,
    petName,
    cancelToken,
  };

  const result = await createAppointment(draft, {enforceCapacity: true});
  if (!result.ok) {
    if (result.reason === "outside_hours") {
      return jsonWithHeaders(errorBody("invalid_input", "This time is not within the clinic's bookable hours."), {
        status: 400,
        headers: rateLimit.headers,
      });
    }
    return jsonWithHeaders(errorBody("slot_conflict", "This time was just taken. Please pick another."), {
      status: 409,
      headers: rateLimit.headers,
    });
  }

  const ics = await sendBookingConfirmation({
    appointment: result.appointment,
    serviceName: service.name,
    clientEmail: parsed.data.client.email,
    clientName: client.name,
    petName: parsed.data.petName,
    notes: parsed.data.notes,
  });

  return jsonWithHeaders(
    {
      appointmentId: result.appointment.appointmentId,
      status: toPublicAppointmentStatus(result.appointment.status),
      ics,
    },
    {status: 201, headers: rateLimit.headers},
  );
}
