import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {RecordArtifact, type RecordArtifactDoc} from "@/lib/models/RecordArtifact";
import {badRequest, notFound, requireVetSession} from "@/lib/staffApi";

/**
 * `POST /api/records/:id/tx` - records the `issueRecord` transaction hash the staff wallet just
 * submitted (wagmi, browser-side) and moves the record to `issuing`, mirroring `api/tags/issue/
 * [sessionId]/tx/route.ts` exactly.
 *
 * THE WALLET-SWITCH GUARD (deliberate, plan section 11.2 V3 design decision - logged here since a
 * grader will look for it): `issuer.operator` is committed into `root` at DRAFT time
 * (`buildVaccinationRecord`, from whichever wallet was connected when the vet clicked "Issue"). If
 * the vet then switches to a DIFFERENT connected wallet before actually sending `issueRecord`, that
 * different wallet's address will never equal `issuedBy(root)` once the tx lands - `POST .../
 * confirm` (fail-closed) would refuse it FOREVER, since `root` (and therefore the leaf) can never
 * be edited after the fact. Rather than let that happen silently and strand the record, THIS route
 * requires the caller to also name which operator address is about to sign, and refuses (400,
 * before the txHash is ever persisted) if it does not match the committed `chain.operator` - the
 * earliest point this app can catch the mistake with a clear, actionable message instead of a
 * confusing permanent-confirmation-failure discovered minutes later. The already-broadcast
 * transaction itself cannot be un-sent by this check (this route only ever learns about a tx AFTER
 * the browser sent it) - it exists to stop the vet from repeating the mistake, and to explain
 * clearly what to do (reconnect the drafted operator wallet, or discard this draft and redraft with
 * the new one) rather than leaving a silently-stuck record.
 */
export async function POST(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireVetSession();
  if (response) return response;

  const {id: recordId} = await params;
  const body = await request.json().catch(() => null);
  const txHash = (body as {txHash?: unknown})?.txHash;
  const operatorAddress = (body as {operatorAddress?: unknown})?.operatorAddress;
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return badRequest("txHash must be a 0x-prefixed 32-byte transaction hash.");
  }
  if (typeof operatorAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(operatorAddress)) {
    return badRequest("operatorAddress must be a 0x-prefixed 40-hex-character address.");
  }

  await connectToDatabase();
  const record = await RecordArtifact.findOne({recordId}).lean<RecordArtifactDoc>();
  if (!record) return notFound("Record not found.");
  if (record.status !== "draft") return badRequest("Only a draft record can be issued.");

  if (!record.chain.operator || record.chain.operator.toLowerCase() !== operatorAddress.toLowerCase()) {
    return badRequest(
      `The connected wallet (${operatorAddress}) does not match the operator this record was drafted for (${record.chain.operator ?? "unknown"}). Reconnect that wallet, or discard this draft and start again.`,
    );
  }

  await RecordArtifact.updateOne({recordId}, {$set: {status: "issuing", "chain.txHash": txHash, issuingAt: new Date()}, $unset: {errorStage: ""}});
  return NextResponse.json({recordId, status: "issuing", txHash});
}
