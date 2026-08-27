import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {rotateIcsFeedToken} from "@/lib/models/ClinicSettings";
import {requireStaffSession} from "@/lib/staffApi";

/** `POST /api/ics-feed-token` - rotates the clinic's read-only ics feed token, invalidating any
 * previously-issued feed URL. */
export async function POST() {
  const {response} = await requireStaffSession();
  if (response) return response;

  await connectToDatabase();
  const settings = await rotateIcsFeedToken();
  return NextResponse.json({icsFeedToken: settings.icsFeedToken});
}
