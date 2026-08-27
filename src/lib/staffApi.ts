import "server-only";
import {NextResponse} from "next/server";
import {auth} from "@/auth";

/** Every staff-facing API route (`/api/clients`, `/api/pets`, ...) starts with this - middleware
 * already gates the page routes, but route handlers get their own defense-in-depth session check
 * too, matching the pattern in `src/app/(app)/layout.tsx` and the existing `/api/settings` route. */
export async function requireStaffSession() {
  const session = await auth();
  if (!session?.user) {
    return {
      session: null,
      response: NextResponse.json({error: {code: "unauthorized", message: "Sign in required."}}, {status: 401}),
    } as const;
  }
  return {session, response: null} as const;
}

export function badRequest(message: string, details?: unknown) {
  return NextResponse.json({error: {code: "invalid_input", message, ...(details ? {details} : {})}}, {status: 400});
}

export function notFound(message = "Not found.") {
  return NextResponse.json({error: {code: "not_found", message}}, {status: 404});
}
