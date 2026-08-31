import {NextResponse} from "next/server";
import {resolveTagging} from "@/lib/booking/appointmentTagging";
import {isValidStatusTransition} from "@/lib/booking/appointmentStatusGuard";
import {setAppointmentTerminalStatus} from "@/lib/booking/lifecycle";
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
 * resulting client. Both kinds of change can land in the same request (e.g. cancelling AND
 * untagging in one save); the response always reflects a fresh read after both have applied.
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

  const updated = await Appointment.findOne({appointmentId: id}).lean<AppointmentDoc>();
  return NextResponse.json(updated);
}
