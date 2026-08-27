import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {BookingSettings, getBookingSettings} from "@/lib/models/Availability";
import {bookingSettingsSchema} from "@/lib/schemas/availability";
import {badRequest, requireStaffSession} from "@/lib/staffApi";

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
  const updated = await BookingSettings.findByIdAndUpdate(BOOKING_SETTINGS_ID, {$set: parsed.data}, {
    upsert: true,
    new: true,
  }).lean();
  return NextResponse.json(updated);
}
