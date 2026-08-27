import {computeCancellable, loadServiceName} from "@/lib/booking/appointmentStatus";
import {setAppointmentTerminalStatus} from "@/lib/booking/lifecycle";
import {toPublicAppointmentStatus} from "@/lib/booking/status";
import {connectToDatabase} from "@/lib/db";
import {Appointment, type AppointmentDoc} from "@/lib/models/Appointment";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";

/** `POST /v1/booking/appointments/{id}/cancel` - `vet-public-api.yaml`. Same token gate as the
 * status endpoint; releases the capacity buckets the appointment held so the slot reopens. */
export async function POST(request: Request, {params}: {params: Promise<{id: string}>}) {
  const rateLimit = enforceRateLimit(request, "booking-appointment-cancel", 10, 60_000);
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
  const cancellable = await computeCancellable(appointment, now);
  if (!cancellable) {
    const reason =
      appointment.status === "cancelled"
        ? "This appointment is already cancelled."
        : "This appointment can no longer be cancelled online.";
    return jsonWithHeaders(errorBody("cancellation_not_allowed", reason), {
      status: 409,
      headers: rateLimit.headers,
    });
  }

  const updated = (await setAppointmentTerminalStatus(id, "cancelled")) as AppointmentDoc;
  const serviceName = await loadServiceName(updated.serviceId);
  return jsonWithHeaders(
    {
      appointmentId: updated.appointmentId,
      status: toPublicAppointmentStatus("cancelled"),
      startAt: new Date(updated.startAt * 1000).toISOString(),
      serviceName,
      cancellable: false,
    },
    {headers: rateLimit.headers},
  );
}
