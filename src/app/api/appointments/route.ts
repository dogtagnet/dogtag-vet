import {NextResponse} from "next/server";
import {randomUUID} from "node:crypto";
import {resolveTagging} from "@/lib/booking/appointmentTagging";
import {createAppointment} from "@/lib/booking/lifecycle";
import type {AppointmentDraft} from "@/lib/booking/mongoStore";
import {connectToDatabase} from "@/lib/db";
import {Appointment, type AppointmentDoc} from "@/lib/models/Appointment";
import {createAppointmentSchema, listAppointmentsQuerySchema} from "@/lib/schemas/appointment";
import {badRequest, requireStaffSession} from "@/lib/staffApi";

/** `GET /api/appointments` - the v1 query vocabulary: `q, clientId, petId, status, from, to`. `q`
 * matches against the denormalized `clientName`/`petName` strings (appointments have no
 * `searchKey` of their own - they're small enough, and usually filtered by date range anyway). */
export async function GET(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const url = new URL(request.url);
  const parsed = listAppointmentsQuerySchema.safeParse({
    q: url.searchParams.get("q") ?? undefined,
    clientId: url.searchParams.get("clientId") ?? undefined,
    petId: url.searchParams.get("petId") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
    from: url.searchParams.get("from") ? Number(url.searchParams.get("from")) : undefined,
    to: url.searchParams.get("to") ? Number(url.searchParams.get("to")) : undefined,
  });
  if (!parsed.success) return badRequest("Malformed query.", parsed.error.flatten());

  const filter: Record<string, unknown> = {};
  if (parsed.data.clientId) filter.clientId = parsed.data.clientId;
  // `petIds` is an array field - a scalar equality filter against it matches any document whose
  // array CONTAINS that value, which is exactly "appointments this pet is tagged on" (the `petId`
  // wire param name stays singular; only the field it filters changed shape).
  if (parsed.data.petId) filter.petIds = parsed.data.petId;
  if (parsed.data.status) filter.status = parsed.data.status;
  if (parsed.data.source) filter.source = parsed.data.source;
  if (parsed.data.from !== undefined || parsed.data.to !== undefined) {
    filter.startAt = {
      ...(parsed.data.from !== undefined ? {$gte: parsed.data.from} : {}),
      ...(parsed.data.to !== undefined ? {$lt: parsed.data.to} : {}),
    };
  }
  if (parsed.data.q) {
    const escaped = parsed.data.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [{clientName: {$regex: escaped, $options: "i"}}, {petName: {$regex: escaped, $options: "i"}}];
  }

  await connectToDatabase();
  const appointments = await Appointment.find(filter).sort({startAt: 1}).limit(500).lean<AppointmentDoc[]>();
  return NextResponse.json(appointments);
}

/** `POST /api/appointments` - staff create. Goes through the same `createAppointment` chokepoint
 * as public booking so the capacity-bucket ledger stays truthful, but with `enforceCapacity:
 * false` - staff can already see the calendar and choose to double-book deliberately (a walk-in
 * emergency, say); nothing here should silently block a staff member from doing their job.
 *
 * Accepts either a tagged payload (`clientId` + at least one `petId`) or a walk-in payload (free-
 * text `clientName`/`petName`) - `createAppointmentSchema`'s own refinement rejects a mix or a
 * neither. When tagged, `resolveTagging` re-derives `clientName`/`petName` from the live records
 * (never trusting client-supplied text for a tagged appointment) and validates every petId
 * actually belongs to that client. */
export async function POST(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = createAppointmentSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed appointment payload.", parsed.error.flatten());
  if (parsed.data.endAt <= parsed.data.startAt) return badRequest("endAt must be after startAt.");

  await connectToDatabase();
  const resolved = await resolveTagging(
    {petIds: [], clientName: parsed.data.clientName ?? "", petName: parsed.data.petName ?? ""},
    {clientId: parsed.data.clientId, petIds: parsed.data.petIds},
  );
  if (!resolved.ok) return badRequest(resolved.error.message);

  const draft: AppointmentDraft = {
    serviceId: parsed.data.serviceId,
    staffName: parsed.data.staffName,
    startAt: parsed.data.startAt,
    endAt: parsed.data.endAt,
    notes: parsed.data.notes,
    source: parsed.data.source,
    clientId: resolved.result.setClientId,
    petIds: resolved.result.setPetIds,
    clientName: resolved.result.clientName,
    petName: resolved.result.petName,
    cancelToken: parsed.data.source === "staff" ? undefined : randomUUID(),
  };
  const result = await createAppointment(draft, {enforceCapacity: false});
  if (!result.ok) {
    // Only reachable if enforceCapacity is ever flipped on for this path in the future.
    return badRequest("This time is not bookable.");
  }
  return NextResponse.json(result.appointment, {status: 201});
}
