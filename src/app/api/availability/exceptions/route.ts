import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {AvailabilityException, type AvailabilityExceptionDoc} from "@/lib/models/Availability";
import {availabilityExceptionSchema} from "@/lib/schemas/availability";
import {badRequest, requireStaffSession} from "@/lib/staffApi";

export async function GET() {
  const {response} = await requireStaffSession();
  if (response) return response;

  await connectToDatabase();
  const exceptions = await AvailabilityException.find({}).sort({date: 1}).lean<AvailabilityExceptionDoc[]>();
  return NextResponse.json(exceptions);
}

export async function POST(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = availabilityExceptionSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed availability exception.", parsed.error.flatten());

  await connectToDatabase();
  const created = await AvailabilityException.findOneAndUpdate({date: parsed.data.date}, {$set: parsed.data}, {
    upsert: true,
    new: true,
  }).lean();
  return NextResponse.json(created, {status: 201});
}
