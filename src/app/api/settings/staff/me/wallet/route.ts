import {NextResponse} from "next/server";
import {setStaffProfile} from "@/lib/models/Staff";
import {selfWalletSchema} from "@/lib/schemas/staff";
import {badRequest, requireVetSession} from "@/lib/staffApi";

/**
 * `PATCH /api/settings/staff/me/wallet {walletAddress: string | null}` - the self-service
 * counterpart to the owner-only `PATCH /api/settings/staff/:staffId` (K2, WP4.7C item 2: "the vet
 * can register their own... address, or the owner can assign to them as well" - that owner path
 * is `StaffSection`'s existing "Practitioner profiles" wallet field and is unchanged by this
 * route). `requireVetSession` (vet OR owner, re-read fresh from Mongo) both gates and SUPPLIES the
 * target row: `staff.staffId` comes from the session, never from the request body or a URL param,
 * so there is no way for this route to ever read or write any row but the caller's own, and
 * `selfWalletSchema` has no `role` key at all (`.strict()` rejects an unexpected one outright) -
 * this route can never change who is vet/owner/staff, disable anyone, or touch bookable/
 * displayName, only the caller's own `walletAddress`.
 *
 * `walletAddress: null` explicitly clears a previously-recorded wallet (`setStaffProfile`'s
 * documented `$unset` signal) - the same contract the owner-only route already uses, reused here
 * rather than re-implemented, per this WP's own "extend, never duplicate" instruction.
 */
export async function PATCH(request: Request) {
  const {staff, response} = await requireVetSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = selfWalletSchema.safeParse(body);
  if (!parsed.success) {
    // Same fix as the sibling owner-only route's own doc comment: the first issue is always the
    // one relevant failure for a single-field schema like this one.
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input.", parsed.error.flatten());
  }

  const updated = await setStaffProfile(staff.staffId, {walletAddress: parsed.data.walletAddress});
  return NextResponse.json(updated);
}
