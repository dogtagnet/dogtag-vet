import {NextResponse} from "next/server";
import {resolveTagging} from "@/lib/booking/appointmentTagging";
import {localDateMinuteToUtcSeconds} from "@/lib/booking/dst";
import {createAppointment} from "@/lib/booking/lifecycle";
import type {AppointmentDraft} from "@/lib/booking/mongoStore";
import {connectToDatabase} from "@/lib/db";
import {getBookingSettings} from "@/lib/models/Availability";
import {createAppointmentFromLocalTimeSchema} from "@/lib/schemas/appointment";
import {badRequest, requireStaffSession} from "@/lib/staffApi";

/**
 * `POST /api/appointments/from-local-time` - the staff calendar's click-to-create action. The
 * grid works in clinic-local wall-clock terms (a date and a time-of-day cell); this resolves that
 * through the same DST-safe `localDateMinuteToUtcSeconds` the booking engine uses, rather than
 * asking the browser to do timezone math. Always staff-sourced, never capacity-blocked (see
 * `createAppointment`'s doc comment).
 *
 * Accepts either a tagged payload (`clientId` + at least one `petId`, from the calendar dialog's
 * ClientPicker/PetMultiPicker) or a walk-in payload (free-text `clientName`/`petName`, the "Walk-in
 * (no client record)" toggle) - `createAppointmentFromLocalTimeSchema`'s refinement rejects a mix
 * or a neither. See `resolveTagging`'s doc comment for the tagged path's server-side re-derivation
 * and pet-ownership validation.
 */
export async function POST(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = createAppointmentFromLocalTimeSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed appointment payload.", parsed.error.flatten());

  await connectToDatabase();
  const resolved = await resolveTagging(
    {petIds: [], clientName: parsed.data.clientName ?? "", petName: parsed.data.petName ?? ""},
    {clientId: parsed.data.clientId, petIds: parsed.data.petIds},
  );
  if (!resolved.ok) return badRequest(resolved.error.message);

  const settings = await getBookingSettings();
  const [dateStr = "", timeStr = ""] = parsed.data.localIso.split("T");
  const [hourStr = "0", minuteStr = "0"] = timeStr.split(":");
  const minuteOfDay = Number(hourStr) * 60 + Number(minuteStr);
  const startAt = localDateMinuteToUtcSeconds(dateStr, minuteOfDay, settings.timezone);
  if (startAt === null) return badRequest("That local time does not exist in the clinic's timezone.");
  const endAt = startAt + parsed.data.durationMinutes * 60;

  const draft: AppointmentDraft = {
    serviceId: parsed.data.serviceId,
    startAt,
    endAt,
    notes: parsed.data.notes,
    source: "staff",
    clientId: resolved.result.setClientId,
    petIds: resolved.result.setPetIds,
    clientName: resolved.result.clientName,
    petName: resolved.result.petName,
    practitionerStaffId: parsed.data.practitionerId,
  };

  const result = await createAppointment(draft, {enforceCapacity: false});
  if (!result.ok) {
    // enforceCapacity is false for every staff booking, so "outside_hours"/"slot_conflict" are not
    // reachable here (see createAppointment's own dispatch) - only a requested practitioner that
    // does not exist, or is no longer bookable, can fail this call.
    if (result.reason === "invalid_practitioner") return badRequest("That practitioner is not bookable.");
    return badRequest("Could not create this appointment.");
  }
  return NextResponse.json(result.appointment, {status: 201});
}
