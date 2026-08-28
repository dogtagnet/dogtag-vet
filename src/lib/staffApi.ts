import "server-only";
import {NextResponse} from "next/server";
import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {Staff, type StaffDoc} from "@/lib/models/Staff";

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

export function badRequest(message: string, details?: unknown) {
  return NextResponse.json({error: {code: "invalid_input", message, ...(details ? {details} : {})}}, {status: 400});
}

export function notFound(message = "Not found.") {
  return NextResponse.json({error: {code: "not_found", message}}, {status: 404});
}
