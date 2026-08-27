import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {VerifySession, type VerifySessionDoc} from "@/lib/models/VerifySession";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

/** `POST /api/verify/:sessionId/recorded {txHash}` - the staff wallet's `recordVerificationZK`
 * tx confirmed; store the nullifier (from the session's own stored proof, never re-trusted from
 * the request body) and txHash, and set `recorded`. */
export async function POST(request: Request, {params}: {params: Promise<{sessionId: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {sessionId} = await params;
  const body = (await request.json().catch(() => null)) as {txHash?: unknown} | null;
  if (typeof body?.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
    return badRequest("txHash must be a 0x-prefixed 32-byte transaction hash.");
  }

  await connectToDatabase();
  const session = await VerifySession.findOne({sessionId}).lean<VerifySessionDoc>();
  if (!session) return notFound("Verify session not found.");
  if (session.status !== "proof_received" || !session.proof) {
    return badRequest("Only a session with a received proof can be recorded.");
  }

  const nullifier = session.proof.pubSignals[3]; // pinned order: [dogTagId, purpose, relayer, nullifier, R, recordType, deadline]
  await VerifySession.updateOne(
    {sessionId},
    {$set: {status: "recorded", txHash: body.txHash, nullifier}},
  );

  return NextResponse.json({sessionId, status: "recorded", txHash: body.txHash, nullifier});
}
