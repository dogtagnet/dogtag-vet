import {NextResponse} from "next/server";
import {resolveTagging} from "@/lib/booking/appointmentTagging";
import {isValidStatusTransition} from "@/lib/booking/appointmentStatusGuard";
import {reassignPractitioner, setAppointmentTerminalStatus} from "@/lib/booking/lifecycle";
import {connectToDatabase} from "@/lib/db";
import {Appointment, type AppointmentDoc} from "@/lib/models/Appointment";
import {updateAppointmentSchema} from "@/lib/schemas/appointment";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

export async function GET(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  await connectToDatabase();
  const appointment = await Appointment.findOne({appointmentId: id}).lean<AppointmentDoc>();
  if (!appointment) return notFound("Appointment not found.");
  return NextResponse.json(appointment);
}

/**
 * `PATCH /api/appointments/:id` (WP4.3 C6) - `{status?, clientId? (nullable to untag), petIds?,
 * notes?}`, every field independently optional. Status transitions go through
 * `isValidStatusTransition` (the same graph that drives the detail page's action buttons -
 * `appointmentStatusGuard.ts`) before anything is written, and `cancelled`/`no_show` still go
 * through `setAppointmentTerminalStatus` (releases the capacity buckets this appointment held) -
 * every other status is a plain field update. Tagging changes go through `resolveTagging`, which
 * re-derives `clientName`/`petName` from the live records and validates every petId belongs to the
 * resulting client - but ONLY when this request actually mentions `clientId` and/or `petIds`;
 * `resolveTagging` gates its invariant check on that (WP4.3 round-1 fix), so a request that touches
 * neither one - a plain status action, a notes save - always passes through unexamined, regardless
 * of what pre-existing shape the appointment happens to carry (see `appointmentTagging.ts`'s doc
 * comment for why that matters: public-booking appointments are `clientId` set with `petIds`
 * empty, permanently, by design). Both kinds of change can land in the same request (e.g.
 * cancelling AND untagging in one save); the response always reflects a fresh read after both have
 * applied.
 */
export async function PATCH(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  const body = await request.json().catch(() => null);
  const parsed = updateAppointmentSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed appointment update.", parsed.error.flatten());

  await connectToDatabase();
  const existing = await Appointment.findOne({appointmentId: id}).lean<AppointmentDoc>();
  if (!existing) return notFound("Appointment not found.");

  if (parsed.data.status !== undefined && !isValidStatusTransition(existing.status, parsed.data.status)) {
    return badRequest(`Cannot move an appointment from "${existing.status}" to "${parsed.data.status}".`);
  }

  const resolved = await resolveTagging(
    {clientId: existing.clientId, petIds: existing.petIds ?? [], clientName: existing.clientName, petName: existing.petName},
    {clientId: parsed.data.clientId, petIds: parsed.data.petIds},
  );
  if (!resolved.ok) return badRequest(resolved.error.message);

  if (parsed.data.status === "cancelled" || parsed.data.status === "no_show") {
    const released = await setAppointmentTerminalStatus(id, parsed.data.status);
    if (!released) return notFound("Appointment not found.");
  } else if (parsed.data.status !== undefined) {
    await Appointment.updateOne({appointmentId: id}, {$set: {status: parsed.data.status}});
  }

  const setOps: Record<string, unknown> = {clientName: resolved.result.clientName, petName: resolved.result.petName};
  if (resolved.result.setClientId !== undefined) setOps.clientId = resolved.result.setClientId;
  if (resolved.result.setPetIds !== undefined) setOps.petIds = resolved.result.setPetIds;
  if (parsed.data.notes !== undefined) setOps.notes = parsed.data.notes;
  const unsetOps: Record<string, ""> = {};
  if (resolved.result.unsetClientId) unsetOps.clientId = "";

  const update: Record<string, unknown> = {$set: setOps};
  if (Object.keys(unsetOps).length > 0) update.$unset = unsetOps;
  await Appointment.updateOne({appointmentId: id}, update);

  // WP4.7 A6 - after status/tagging above, not before: a combined cancel-and-reassign in the same
  // request must reassign against the NOW-cancelled status (reassignPractitioner re-reads fresh),
  // which correctly takes its plain-field-update path rather than trying to move live buckets a
  // cancellation already released. `practitionerId` uses the same absent/null/value convention as
  // `clientId` - only act on it when the key is actually present in the patch.
  if (parsed.data.practitionerId !== undefined) {
    const reassigned = await reassignPractitioner(id, parsed.data.practitionerId);
    if (!reassigned.ok) {
      if (reassigned.reason === "not_found") return notFound("Appointment not found.");
      if (reassigned.reason === "slot_conflict") return badRequest("That practitioner is already booked at this time.");
      if (reassigned.reason === "outside_hours") return badRequest("That practitioner's hours do not cover this appointment's time.");
      return badRequest("That practitioner is not bookable.");
    }
  }

  const updated = await Appointment.findOne({appointmentId: id}).lean<AppointmentDoc>();
  return NextResponse.json(updated);
}
