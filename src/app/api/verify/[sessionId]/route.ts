import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {VerifySession, type VerifySessionDoc} from "@/lib/models/VerifySession";
import {notFound, requireStaffSession} from "@/lib/staffApi";

/** `GET /api/verify/:sessionId` - staff poll while waiting for the owner's device to submit a
 * proof (`pending` -> `proof_received`), then after the relayer wallet submits on chain
 * (-> `recorded`). */
export async function GET(_request: Request, {params}: {params: Promise<{sessionId: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {sessionId} = await params;
  await connectToDatabase();
  const session = await VerifySession.findOne({sessionId}).lean<VerifySessionDoc>();
  if (!session) return notFound("Verify session not found.");

  return NextResponse.json({
    sessionId: session.sessionId,
    status: session.status,
    purpose: session.purpose,
    recordType: session.recordType,
    relayerAddress: session.relayerAddress,
    challenge: session.challenge,
    // The full proof is exposed only once received - it is what the staff wallet's
    // `recordVerificationZK` call needs as its exact `(a, b, c, pub)` arguments.
    proof: session.proof,
    hasDisclosure: Boolean(session.profileDisclosure),
    disclosedKeyPaths: session.disclosedKeyPaths,
    txHash: session.txHash,
    nullifier: session.nullifier,
  });
}
