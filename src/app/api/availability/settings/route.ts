import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {BookingSettings, getBookingSettings} from "@/lib/models/Availability";
import {bookingSettingsSchema} from "@/lib/schemas/availability";
import {badRequest, requireOwnerSession, requireStaffSession} from "@/lib/staffApi";
import {hasPractitionerReadyForSchedulingMode} from "@/lib/booking/queries";

const BOOKING_SETTINGS_ID = "singleton";

export async function GET() {
  const {response} = await requireStaffSession();
  if (response) return response;

  await connectToDatabase();
  return NextResponse.json(await getBookingSettings());
}

export async function PATCH(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = bookingSettingsSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed booking settings.", parsed.error.flatten());

  // WP4.7A orchestrator ruling R2 (FIX ROUND 1): schedulingMode is a clinic-wide switch coupled to
  // D3's unassigned-blocks-all guarantee and the AvailabilityException index migration (see
  // docs/DEPLOY.md) - too consequential for a plain staff member to flip, unlike every OTHER field
  // this route accepts (timezone, notice/advance windows, slot granularity), which stay
  // staff-editable exactly as before. Checked on every patch that CARRIES the field, even resending
  // the current value unchanged - the same "checked on every save, not just the original switch"
  // precedent D1's own check just below already established for this same field.
  if (parsed.data.schedulingMode !== undefined) {
    const owner = await requireOwnerSession();
    if (owner.response) return owner.response;
  }

  await connectToDatabase();

  // WP4.7 D1 - checked on every patch that carries "practitioner", not only when actually changing
  // FROM clinic mode: a re-save of an already-"practitioner" setting should fail exactly the same
  // way if the precondition no longer holds (e.g. the one qualifying practitioner was since made
  // unbookable), rather than only being checked at the moment of the original switch.
  if (parsed.data.schedulingMode === "practitioner" && !(await hasPractitionerReadyForSchedulingMode())) {
    return badRequest(
      "Switching to per-practitioner scheduling needs at least one vet or owner marked bookable, and that practitioner needs at least one weekly hours rule of their own. Set both up first, then switch modes.",
    );
  }

  const updated = await BookingSettings.findByIdAndUpdate(BOOKING_SETTINGS_ID, {$set: parsed.data}, {
    upsert: true,
    new: true,
  }).lean();
  return NextResponse.json(updated);
}
