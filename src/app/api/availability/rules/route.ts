import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {AvailabilityRule, type AvailabilityRuleDoc} from "@/lib/models/Availability";
import {availabilityRuleSchema} from "@/lib/schemas/availability";
import {badRequest, requireStaffSession} from "@/lib/staffApi";

export async function GET() {
  const {response} = await requireStaffSession();
  if (response) return response;

  await connectToDatabase();
  const rules = await AvailabilityRule.find({}).sort({dayOfWeek: 1, startMinute: 1}).lean<AvailabilityRuleDoc[]>();
  return NextResponse.json(rules);
}

export async function POST(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = availabilityRuleSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed availability rule.", parsed.error.flatten());

  await connectToDatabase();
  const created = await AvailabilityRule.create(parsed.data);
  return NextResponse.json(created.toObject(), {status: 201});
}
