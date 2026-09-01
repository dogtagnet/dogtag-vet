import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {countActiveOwners, Staff, setStaffDisabled, setStaffRole, wouldRemoveActiveOwnerStatus, type StaffDoc} from "@/lib/models/Staff";
import {updateStaffSchema} from "@/lib/schemas/staff";
import {badRequest, notFound, requireOwnerSession} from "@/lib/staffApi";

/**
 * `PATCH /api/settings/staff/:staffId {role?, disabled?}` - owner-only. Backs both "revoke access"
 * (`disabled: true` - a flag, never a delete; see `Staff.ts`'s doc comment on why) and changing a
 * staff member's role.
 *
 * Two guardrails an owner cannot bypass through this route:
 * - An owner can never modify their OWN row here (demoting or disabling yourself locks you out
 *   with no one left to undo it from this same session) - use another owner account instead.
 * - The deployment must always keep at least one active (non-disabled) `owner`; a change that
 *   would drop the last one is refused.
 */
export async function PATCH(request: Request, {params}: {params: Promise<{staffId: string}>}) {
  const {session, response} = await requireOwnerSession();
  if (response) return response;

  const {staffId} = await params;
  if (staffId === session.user.staffId) {
    return badRequest("Use another owner account to change your own access.");
  }

  const body = await request.json().catch(() => null);
  const parsed = updateStaffSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {error: {code: "invalid_input", message: "role or disabled is required.", details: parsed.error.flatten()}},
      {status: 400},
    );
  }

  await connectToDatabase();
  const target = await Staff.findOne({staffId}).lean<StaffDoc>();
  if (!target) return notFound("Staff member not found.");

  const removesOwnerStatus = wouldRemoveActiveOwnerStatus(target, parsed.data);
  if (removesOwnerStatus && (await countActiveOwners()) <= 1) {
    return badRequest("At least one active owner must remain - invite or promote another owner first.");
  }

  let updated = target;
  if (parsed.data.role !== undefined) updated = (await setStaffRole(staffId, parsed.data.role)) ?? updated;
  if (parsed.data.disabled !== undefined) updated = (await setStaffDisabled(staffId, parsed.data.disabled)) ?? updated;

  return NextResponse.json(updated);
}
