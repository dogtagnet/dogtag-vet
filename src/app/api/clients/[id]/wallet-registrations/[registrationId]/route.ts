import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {getRegistrationSessionStatus} from "@/lib/registration/flow";
import {mongoRegistrationStore} from "@/lib/registration/mongoStore";
import {notFound, requireStaffSession} from "@/lib/staffApi";

/**
 * `GET /api/clients/:id/wallet-registrations/:registrationId` - the staff-facing live status poll
 * behind the Wallets panel's "Waiting for scan..." state. Looked up by `registrationId`, never the
 * public one-time `token`, mirroring how mint's own staff poll
 * (`GET /api/tags/issue/:sessionId`) uses the internal `sessionId` rather than its bind token.
 */
export async function GET(_request: Request, {params}: {params: Promise<{id: string; registrationId: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id, registrationId} = await params;
  await connectToDatabase();
  const now = Math.floor(Date.now() / 1000);
  const result = await getRegistrationSessionStatus(mongoRegistrationStore, id, registrationId, now);
  if (!result.ok) return notFound("Wallet registration session not found.");

  // WP4.5 track3-sig fix 3: `outcome` is only ever meaningful (and only ever set) alongside
  // `status: "failed"` - see `getRegistrationSessionStatus`'s own doc comment - but passed through
  // unconditionally here rather than gated on that status, so the panel's copy logic is the one
  // place responsible for deciding when it matters, not this route.
  return NextResponse.json({status: result.status, wallet: result.wallet, outcome: result.outcome});
}
