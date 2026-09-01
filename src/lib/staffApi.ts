import "server-only";
import {NextResponse} from "next/server";
import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {isVetOrOwner, Staff, type StaffDoc} from "@/lib/models/Staff";

/** Every staff-facing API route (`/api/clients`, `/api/pets`, ...) starts with this - middleware
 * already gates the page routes, but route handlers get their own defense-in-depth session check
 * too, matching the pattern in `src/app/(app)/layout.tsx` and the existing `/api/settings` route. */
export async function requireStaffSession() {
  const session = await auth();
  if (!session?.user?.staffId) {
    return {
      session: null,
      response: NextResponse.json({error: {code: "unauthorized", message: "Sign in required."}}, {status: 401}),
    } as const;
  }
  return {session, response: null} as const;
}

/**
 * Staff-management routes (inviting, disabling, re-roling another staff account) require the
 * CURRENT `owner` role, re-read from Mongo rather than trusted from the session token - an
 * already-issued JWT can outlive a demotion (`setStaffRole`) for as long as the token strategy's
 * refresh window, so the one action that changes who else can act as owner must never trust a
 * possibly-stale claim about being one.
 */
export async function requireOwnerSession() {
  const {session, response} = await requireStaffSession();
  if (response) return {session: null, staff: null, response} as const;

  await connectToDatabase();
  const staff = await Staff.findOne({staffId: session.user.staffId}).lean<StaffDoc>();
  if (!staff || staff.disabled || staff.role !== "owner") {
    return {
      session: null,
      staff: null,
      response: NextResponse.json({error: {code: "forbidden", message: "Only an owner can do this."}}, {status: 403}),
    } as const;
  }
  return {session, staff, response: null} as const;
}

/**
 * DogTag issuance routes (recording an on-chain tx, confirming/retrying an issuance session)
 * require the CURRENT `vet` OR `owner` role, re-read from Mongo for the exact same reason
 * `requireOwnerSession` re-reads rather than trusting the session token - a demotion
 * (`setStaffRole`) must take effect before the token's own refresh window would otherwise notice.
 *
 * This is app-side UX plus defense in depth, never the actual security boundary: the chain's own
 * `VetIssuer.operators` whitelist (granted per the vet's personal wallet - D4,
 * `plans/wp4.7-vet-role-practitioner-availability.md`) is what a write ultimately lives or dies by
 * - a `vet`/`owner` role here with no on-chain operator grant still can't get `issueTag`/
 * `issueRecord` to succeed. Gating the app surface anyway keeps a non-issuing staff member from
 * ever reaching a confusing on-chain revert as their first signal that they lack access.
 */
export async function requireVetSession() {
  const {session, response} = await requireStaffSession();
  if (response) return {session: null, staff: null, response} as const;

  await connectToDatabase();
  const staff = await Staff.findOne({staffId: session.user.staffId}).lean<StaffDoc>();
  if (!staff || staff.disabled || !isVetOrOwner(staff.role)) {
    return {
      session: null,
      staff: null,
      response: NextResponse.json(
        {error: {code: "forbidden", message: "Only a vet or owner can do this."}},
        {status: 403},
      ),
    } as const;
  }
  return {session, staff, response: null} as const;
}

export function badRequest(message: string, details?: unknown) {
  return NextResponse.json({error: {code: "invalid_input", message, ...(details ? {details} : {})}}, {status: 400});
}

export function notFound(message = "Not found.") {
  return NextResponse.json({error: {code: "not_found", message}}, {status: 404});
}
