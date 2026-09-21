import {computeCancellable, loadServiceName} from "@/lib/booking/appointmentStatus";
import {toPublicAppointmentStatus} from "@/lib/booking/status";
import {connectToDatabase} from "@/lib/db";
import {Appointment, type AppointmentDoc} from "@/lib/models/Appointment";
import {Payment, type PaymentDoc} from "@/lib/models/Payment";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";

/**
 * `GET /v1/booking/appointments/{id}` - `vet-public-api.yaml`. Client-facing, gated by the
 * per-appointment `token` issued at booking time - no staff auth.
 *
 * WP4.18 V6 adds `invoices`: every `Payment` linked to this appointment (`Payment.appointmentId`),
 * reduced to just what the phone needs to fetch `GET /v1/payments/{id}/public` for each one
 * itself - `paymentId` and `viewToken` (the SAME bearer token that already gates that endpoint;
 * exposing it here carries no new trust boundary, since this whole response is already gated by
 * the appointment's own `cancelToken`) - plus `status` so a list of several invoices can render
 * without waiting on N further round trips. Additive: an old client that never reads `invoices`
 * keeps working unchanged. Omitted entirely (never an empty array) when this appointment has no
 * linked invoice, matching this endpoint's existing "absent, not null" convention.
 */
export async function GET(request: Request, {params}: {params: Promise<{id: string}>}) {
  const rateLimit = enforceRateLimit(request, "booking-appointment-status", 30, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const {id} = await params;
  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return jsonWithHeaders(errorBody("unauthorized", "token is required."), {
      status: 401,
      headers: rateLimit.headers,
    });
  }

  await connectToDatabase();
  const appointment = await Appointment.findOne({appointmentId: id}).lean<AppointmentDoc>();
  if (!appointment) {
    return jsonWithHeaders(errorBody("not_found", "Appointment not found."), {
      status: 404,
      headers: rateLimit.headers,
    });
  }
  if (!appointment.cancelToken || appointment.cancelToken !== token) {
    return jsonWithHeaders(errorBody("unauthorized", "token does not match this appointment."), {
      status: 401,
      headers: rateLimit.headers,
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const [serviceName, cancellable, payments] = await Promise.all([
    loadServiceName(appointment.serviceId),
    computeCancellable(appointment, now),
    Payment.find({appointmentId: appointment.appointmentId}).lean<PaymentDoc[]>(),
  ]);

  return jsonWithHeaders(
    {
      appointmentId: appointment.appointmentId,
      status: toPublicAppointmentStatus(appointment.status),
      startAt: new Date(appointment.startAt * 1000).toISOString(),
      serviceName,
      cancellable,
      ...(payments.length > 0
        ? {
            invoices: payments.map((p) => ({
              paymentId: p.paymentId,
              viewToken: p.viewToken,
              status: p.status,
            })),
          }
        : {}),
    },
    {headers: rateLimit.headers},
  );
}
