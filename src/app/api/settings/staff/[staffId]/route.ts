import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {
  countActiveOwners,
  Staff,
  setStaffDisabled,
  setStaffProfile,
  setStaffRole,
  wouldRemoveActiveOwnerStatus,
  type StaffDoc,
} from "@/lib/models/Staff";
import {updateStaffSchema} from "@/lib/schemas/staff";
import {badRequest, notFound, requireOwnerSession} from "@/lib/staffApi";

/**
 * `PATCH /api/settings/staff/:staffId {role?, disabled?, bookable?, displayName?, firstName?,
 * lastName?, title?, accreditationNumber?, walletAddress?}` - owner-only. Backs "revoke access"
 * (`disabled: true` - a flag, never a delete; see `Staff.ts`'s doc comment on why), changing a
 * staff member's role, and the practitioner-profile fields: `bookable` (WP4.7 D2), `displayName`
 * (WP4.7 D2, now deprecated), `firstName`/`lastName`/`title`/`accreditationNumber` (WP4.13), and
 * `walletAddress` (WP4.7 D4). An owner edits everyone's row here, including their own; a vet/owner
 * may ALSO edit a SUBSET of their own fields directly via the self-service `/me/wallet` (WP4.7C)
 * and `/me/profile` (WP4.13) routes - both paths call the same `setStaffProfile`, never a
 * duplicated write path.
 *
 * Guardrails an owner cannot bypass through this route:
 * - An owner can never change their OWN `role` or `disabled` here (demoting or disabling yourself
 *   locks you out with no one left to undo it from this same session) - use another owner account
 *   instead. This does NOT extend to the profile fields: D2 explicitly allows an `owner` to also be
 *   a practitioner (the common solo-vet-owner clinic shape), and there would be no other path at
 *   all to mark that owner `bookable`/record their own wallet if this route refused its own row
 *   unconditionally - so an owner MAY patch their own `bookable`/`displayName`/`walletAddress`.
 * - The deployment must always keep at least one active (non-disabled) `owner`; a role/disabled
 *   change that would drop the last one is refused.
 */
export async function PATCH(request: Request, {params}: {params: Promise<{staffId: string}>}) {
  const {session, response} = await requireOwnerSession();
  if (response) return response;

  const {staffId} = await params;
  const body = await request.json().catch(() => null);
  const parsed = updateStaffSchema.safeParse(body);
  if (!parsed.success) {
    // Was hardcoded to the top-level `.refine`'s own message ("At least one field is required.")
    // regardless of WHICH check actually failed - wrong and confusing for, say, a malformed
    // `walletAddress` (zod never even reaches the whole-object `.refine` when a field itself fails
    // its own schema, so that case's real message - "Must be a 0x-prefixed 40-hex-character
    // address" - was silently discarded in favor of the unrelated refine text). `issues[0]` is
    // always the one relevant failure for this schema (a field regex/type failure when one exists,
    // else the refine's own "at least one field" message when the body was empty), found and fixed
    // in passing while building WP4.7C's self-service counterpart route, which uses this same
    // pattern from the start - see `selfWalletSchema`'s route.
    return NextResponse.json(
      {error: {code: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid input.", details: parsed.error.flatten()}},
      {status: 400},
    );
  }

  const editingOwnRow = staffId === session.user.staffId;
  if (editingOwnRow && (parsed.data.role !== undefined || parsed.data.disabled !== undefined)) {
    return badRequest("Use another owner account to change your own role or access.");
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
  if (
    parsed.data.bookable !== undefined ||
    parsed.data.displayName !== undefined ||
    parsed.data.firstName !== undefined ||
    parsed.data.lastName !== undefined ||
    parsed.data.title !== undefined ||
    parsed.data.accreditationNumber !== undefined ||
    parsed.data.walletAddress !== undefined
  ) {
    updated =
      (await setStaffProfile(staffId, {
        bookable: parsed.data.bookable,
        displayName: parsed.data.displayName,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        title: parsed.data.title,
        accreditationNumber: parsed.data.accreditationNumber,
        walletAddress: parsed.data.walletAddress,
      })) ?? updated;
  }

  return NextResponse.json(updated);
}
