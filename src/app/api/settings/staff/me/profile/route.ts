import {NextResponse} from "next/server";
import {setStaffProfile} from "@/lib/models/Staff";
import {selfProfileSchema} from "@/lib/schemas/staff";
import {badRequest, requireVetSession} from "@/lib/staffApi";

/**
 * `PATCH /api/settings/staff/me/profile {firstName?, lastName?, title?, accreditationNumber?}` -
 * WP4.13's self-service counterpart to the owner-only `PATCH /api/settings/staff/:staffId`
 * (Kenneth issue 3: "split the name of the vet from display name to first name, last name... we
 * also need the qualifications / title field... government accreditation number") - modelled
 * directly on the sibling `.../me/wallet` route (WP4.7C item 2): `requireVetSession` (vet OR
 * owner, re-read fresh from Mongo) both gates and SUPPLIES the target row, so `staff.staffId`
 * comes from the session, never from the request body or a URL param - there is no way for this
 * route to ever read or write any row but the caller's own. `selfProfileSchema` is `.strict()`
 * with no `role`/`disabled`/`bookable`/`walletAddress` key at all, so this route can never change
 * who is vet/owner/staff, disable anyone, or touch bookable/wallet - only the caller's own
 * firstName/lastName/title/accreditationNumber.
 *
 * `null` on any field explicitly clears it (`setStaffProfile`'s existing `$unset` signal, reused
 * here rather than reimplemented) - a vet may remove their own title or accreditation number just
 * as easily as setting one. The accreditation number this route accepts is never returned on any
 * public surface (the booking wire, the calendar, ICS, emails) - it stays Settings-only by design,
 * see `Staff.ts`'s own doc comment on `accreditationNumber`.
 */
export async function PATCH(request: Request) {
  const {staff, response} = await requireVetSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = selfProfileSchema.safeParse(body);
  if (!parsed.success) {
    // Same fix as the sibling owner-only route's own doc comment: the first issue is always the
    // one relevant failure for this schema (a field regex/length failure when one exists, else the
    // refine's own "at least one field" message when the body was empty or unknown-keys-only).
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input.", parsed.error.flatten());
  }

  const updated = await setStaffProfile(staff.staffId, {
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName,
    title: parsed.data.title,
    accreditationNumber: parsed.data.accreditationNumber,
  });
  return NextResponse.json(updated);
}
