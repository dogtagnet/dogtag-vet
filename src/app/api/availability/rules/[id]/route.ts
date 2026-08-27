import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {AvailabilityRule} from "@/lib/models/Availability";
import {notFound, requireStaffSession} from "@/lib/staffApi";

export async function DELETE(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  await connectToDatabase();
  const deleted = await AvailabilityRule.findOneAndDelete({ruleId: id}).lean();
  if (!deleted) return notFound("Availability rule not found.");
  return NextResponse.json({ok: true});
}
