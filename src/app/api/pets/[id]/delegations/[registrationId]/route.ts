import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {getStaffDelegationStatus} from "@/lib/delegation/flow";
import {mongoDelegationStore} from "@/lib/delegation/mongoStore";
import {notFound, requireVetSession} from "@/lib/staffApi";

/**
 * `GET /api/pets/:id/delegations/:registrationId` - the staff-facing live status poll behind the
 * Owners card's "Waiting for scan...", "Add on chain", "Removing..." states, looked up by
 * `registrationId` (never the public one-time `token`), mirroring
 * `GET /api/clients/:id/wallet-registrations/:registrationId`. Serves BOTH `kind`s and the full
 * internal status vocabulary (`errorReason`/`txHash`/`commitment`) - a staff-only surface, unlike
 * the device-facing `/d/:token/status`, which never carries this much detail.
 */
export async function GET(_request: Request, {params}: {params: Promise<{id: string; registrationId: string}>}) {
  const {response} = await requireVetSession();
  if (response) return response;

  const {id, registrationId} = await params;
  await connectToDatabase();
  const result = await getStaffDelegationStatus(mongoDelegationStore, id, registrationId);
  if (!result.ok) return notFound("Delegation session not found.");

  return NextResponse.json(result.status);
}
