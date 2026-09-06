import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {RecordArtifact, type RecordArtifactDoc} from "@/lib/models/RecordArtifact";
import {ChainActivity} from "@/lib/models/ChainActivity";
import {readIsValidRoot} from "@/lib/chainRead";
import {REASON_CODES, type ReasonCodeName} from "@/lib/reasonCodes";
import {badRequest, notFound, requireVetSession} from "@/lib/staffApi";

const REASON_NAMES = new Set<string>(REASON_CODES.map((r) => r.name));

/**
 * `POST /api/records/:id/lifecycle {reasonCode, txHash}` - records the outcome of a `revokeRecord`
 * transaction the staff wallet already sent and confirmed (wagmi, browser-side; no server-held key
 * ever signs this), mirroring `api/tags/[petId]/lifecycle/route.ts`'s own pattern: the clone's own
 * event log is the real source of truth, this route just keeps the UI from waiting on the next
 * worker poll, and re-reads `isValid(root)` itself before trusting the tx rather than assuming the
 * requested action is what actually happened on chain.
 *
 * KEYED BY RECORD ID, NOT PET ID - deliberate, unlike the tag lifecycle route: a pet has exactly one
 * active tag (`Pet.dogTag`, pet-keyed) but MANY independent records, each with its own `root`
 * (`RecordArtifact.ts`'s own header comment), so only the record's own id unambiguously names which
 * one is being revoked.
 *
 * REVOKE ONLY (plan section 11.2 V4's own scope - "revoke (owner/vet with reason -> clone
 * .revokeRecord + confirm)"; no reactivate here, unlike the tag lifecycle route, which the checklist
 * never asks for on the record side of this wave).
 */
export async function POST(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireVetSession();
  if (response) return response;

  const {id: recordId} = await params;
  const body = (await request.json().catch(() => null)) as {reasonCode?: unknown; txHash?: unknown} | null;
  if (typeof body?.reasonCode !== "string" || !REASON_NAMES.has(body.reasonCode)) {
    return badRequest("reasonCode must be one of the known reason codes.");
  }
  if (typeof body.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
    return badRequest("txHash must be a 0x-prefixed 32-byte transaction hash.");
  }

  await connectToDatabase();
  const record = await RecordArtifact.findOne({recordId}).lean<RecordArtifactDoc>();
  if (!record) return notFound("Record not found.");
  if (record.status !== "active") {
    return badRequest("Only an active record can be revoked.");
  }
  if (!record.chain.contract) {
    return badRequest("This record has no anchored clone to revoke against.");
  }

  let valid: boolean;
  try {
    valid = await readIsValidRoot(record.chain.contract as `0x${string}`, record.root as `0x${string}`);
  } catch {
    return badRequest("Could not reach the chain to confirm this action.");
  }
  if (valid) {
    return badRequest("The chain does not yet reflect this action. Wait for the transaction to confirm and retry.");
  }

  await RecordArtifact.updateOne(
    {recordId},
    {$set: {status: "revoked", revokedAt: new Date(), revokedReason: body.reasonCode}},
  );
  await ChainActivity.updateOne(
    {id: `${body.txHash}:staff-record-lifecycle`},
    {
      $setOnInsert: {
        id: `${body.txHash}:staff-record-lifecycle`,
        type: "RecordRevoked",
        blockNumber: 0,
        txHash: body.txHash,
        logIndex: 0,
        blockTimestamp: Math.floor(Date.now() / 1000),
        dogTagId: record.dogTagIdField,
        root: record.root,
        reasonCode: body.reasonCode as ReasonCodeName,
        raw: {source: "staff-record-lifecycle-route"},
      },
    },
    {upsert: true},
  );

  return NextResponse.json({recordId, status: "revoked"});
}
