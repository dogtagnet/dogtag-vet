import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {inviteStaff, listStaff} from "@/lib/models/Staff";
import {inviteStaffSchema} from "@/lib/schemas/staff";
import {badRequest, requireOwnerSession, requireStaffSession} from "@/lib/staffApi";

/** `GET /api/settings/staff` - the staff roster (any signed-in staff can view who else has
 * access; only an owner can change it - see the mutating routes below). */
export async function GET() {
  const {response} = await requireStaffSession();
  if (response) return response;

  await connectToDatabase();
  const staff = await listStaff();
  return NextResponse.json(staff);
}

/**
 * `POST /api/settings/staff {email, role}` - owner-only. Pre-provisions a Staff row for an email
 * that has not signed in yet, the invite half of the gate `isEmailAllowedToSignIn` enforces at
 * sign-in time (wp4-vet.md's auth section names `owner|staff` roles; this is the admin surface a
 * self-deployable, invite-gated staff model needs to actually add a second person - see
 * `auth.ts`'s `signIn` callback for why open self-registration was closed).
 */
export async function POST(request: Request) {
  const {response} = await requireOwnerSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = inviteStaffSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {error: {code: "invalid_input", message: "email and role are required.", details: parsed.error.flatten()}},
      {status: 400},
    );
  }

  await connectToDatabase();
  try {
    const staff = await inviteStaff(parsed.data.email, parsed.data.role);
    return NextResponse.json(staff, {status: 201});
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "Could not invite this staff member.");
  }
}
