import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {MintSession, type MintSessionDoc} from "@/lib/models/MintSession";
import {badRequest, notFound, requireVetSession} from "@/lib/staffApi";

/** `POST /api/tags/issue/:sessionId/tx` - records the `issueTag` transaction hash the staff
 * wallet just submitted (wagmi, browser-side) and moves the session to `issuing`. wp4-vet.md
 * issuance step 5: "session `issuing` with txHash". */
export async function POST(request: Request, {params}: {params: Promise<{sessionId: string}>}) {
  const {response} = await requireVetSession();
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

  // `issuingAt` (not `createdAt`) is what the worker's boot-recovery staleness check measures
  // from - see `MintSession.ts`'s doc comment on that field. `lastIssueError` is cleared here
  // (never left over from a PRIOR reverted attempt): this route only ever fires from `ready`,
  // which is exactly the status a reverted receipt flips a session back to, so a fresh attempt
  // starting now must not keep showing the previous attempt's error once this one is in flight.
  await MintSession.updateOne(
    {sessionId},
    {$set: {status: "issuing", txHash, issuingAt: new Date()}, $unset: {lastIssueError: ""}},
  );
  return NextResponse.json({sessionId, status: "issuing", txHash});
}
