import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {BookingSettings, getBookingSettings} from "@/lib/models/Availability";
import {bookingSettingsSchema} from "@/lib/schemas/availability";
import {badRequest, requireStaffSession} from "@/lib/staffApi";
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
