import {computeCancellable, loadServiceName} from "@/lib/booking/appointmentStatus";
import {toPublicAppointmentStatus} from "@/lib/booking/status";
import {connectToDatabase} from "@/lib/db";
import {Appointment, type AppointmentDoc} from "@/lib/models/Appointment";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";

/** `GET /v1/booking/appointments/{id}` - `vet-public-api.yaml`. Client-facing, gated by the
 * per-appointment `token` issued at booking time - no staff auth. */
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
  const [serviceName, cancellable] = await Promise.all([
    loadServiceName(appointment.serviceId),
    computeCancellable(appointment, now),
  ]);

  return jsonWithHeaders(
    {
      appointmentId: appointment.appointmentId,
      status: toPublicAppointmentStatus(appointment.status),
      startAt: new Date(appointment.startAt * 1000).toISOString(),
      serviceName,
      cancellable,
    },
    {headers: rateLimit.headers},
  );
}
