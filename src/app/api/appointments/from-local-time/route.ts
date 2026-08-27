import {NextResponse} from "next/server";
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
 */
export async function POST(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = createAppointmentFromLocalTimeSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed appointment payload.", parsed.error.flatten());

  await connectToDatabase();
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
    clientName: parsed.data.clientName,
    petName: parsed.data.petName,
  };

  const result = await createAppointment(draft, {enforceCapacity: false});
  if (!result.ok) return badRequest("Could not create this appointment.");
  return NextResponse.json(result.appointment, {status: 201});
}
