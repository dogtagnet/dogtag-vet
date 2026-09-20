import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {DelegationSession, type DelegationSessionDoc} from "@/lib/models/DelegationSession";
import {delegationTxSchema} from "@/lib/schemas/delegation";
import {badRequest, notFound, requireVetSession} from "@/lib/staffApi";

/** `POST /api/pets/:id/delegations/:registrationId/tx {txHash}` - records the
 * `addSecondaryOwner`/`revokeSecondaryOwner` transaction hash the operator wallet just submitted
 * (wagmi, browser-side) and moves the session `"claimed" -> "submitting"`, mirroring
 * `POST /api/tags/issue/:sessionId/tx` exactly (same shape, same "only a session in the right
 * pre-state can be issued" guard). Works for BOTH `kind`s - a revoke session reaches `"claimed"`
 * immediately at creation, so it is just as valid a caller here as an add session that only
 * reaches `"claimed"` after its own device completes `/d/:token/complete`. */
export async function POST(request: Request, {params}: {params: Promise<{id: string; registrationId: string}>}) {
  const {response} = await requireVetSession();
  if (response) return response;

  const {id, registrationId} = await params;
  const body = await request.json().catch(() => null);
  const parsed = delegationTxSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed transaction record.", parsed.error.flatten());

  await connectToDatabase();
  const session = await DelegationSession.findOne({registrationId}).lean<DelegationSessionDoc>();
  if (!session || session.petId !== id) return notFound("Delegation session not found.");
  if (session.status !== "claimed") return badRequest("Only a claimed session can be submitted on chain.");
  if (!session.commitment) return badRequest("This session has no recorded commitment yet.");

  await DelegationSession.updateOne(
    {registrationId, status: "claimed"},
    {$set: {status: "submitting", txHash: parsed.data.txHash, submittingAt: Math.floor(Date.now() / 1000)}, $unset: {errorReason: ""}},
  );
  return NextResponse.json({registrationId, status: "submitting", txHash: parsed.data.txHash});
}
