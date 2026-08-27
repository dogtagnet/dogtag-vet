import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {MintSession, type MintSessionDoc} from "@/lib/models/MintSession";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

/** `POST /api/tags/issue/:sessionId/tx` - records the `issueTag` transaction hash the staff
 * wallet just submitted (wagmi, browser-side) and moves the session to `issuing`. wp4-vet.md
 * issuance step 5: "session `issuing` with txHash". */
export async function POST(request: Request, {params}: {params: Promise<{sessionId: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {sessionId} = await params;
  const body = await request.json().catch(() => null);
  const txHash = (body as {txHash?: unknown})?.txHash;
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return badRequest("txHash must be a 0x-prefixed 32-byte transaction hash.");
  }

  await connectToDatabase();
  const session = await MintSession.findOne({sessionId}).lean<MintSessionDoc>();
  if (!session) return notFound("Mint session not found.");
  if (session.status !== "ready") return badRequest("Only a session that is ready can be issued.");

  await MintSession.updateOne({sessionId}, {$set: {status: "issuing", txHash}});
  return NextResponse.json({sessionId, status: "issuing", txHash});
}
