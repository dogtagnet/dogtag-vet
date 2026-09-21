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
 * each entry carrying `paymentId` and `viewToken` (the SAME bearer token that already gates
 * `GET /v1/payments/{id}/public`; exposing it here carries no new trust boundary, since this
 * whole response is already gated by the appointment's own `cancelToken`) so the phone can fetch
 * full status for each one itself, plus `status`, `fiatAmount` (decimal string, `Payment.total`),
 * `currency` (ISO 4217), and `tokenSymbols` (every currently-open crypto rail's token, `[]` once
 * the invoice carries no open rail - settled/paid, cancelled, or expired - the same iff-condition
 * `wire.ts`'s `toPaymentPublicStatusResponse` uses for its own `rails` field, so a Paid invoice
 * never renders as if it were still payable) so a list of several invoices can render useful
 * context without waiting on N further round trips first. `fiatAmount`/`currency`/`tokenSymbols`
 * were added after the ios and specs waves' own review of this response shape (cross-repo wire
 * contract ruling); the `tokenSymbols` iff-condition itself was corrected in a WP4.18 fix round
 * (D1) after the Fable grade caught it disagreeing with the spec and `docs/appointments.md`.
 * Additive: an old client that never reads `invoices` keeps working unchanged. `invoices` itself
 * is omitted entirely (never an empty array) when this appointment has no linked invoice, matching
 * this endpoint's existing "absent, not null" convention.
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
              fiatAmount: p.total,
              currency: p.currency,
              tokenSymbols: p.status === "pending" ? p.crypto.map((rail) => rail.token) : [],
            })),
          }
        : {}),
    },
    {headers: rateLimit.headers},
  );
}
