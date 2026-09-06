import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {RecordArtifact, type RecordArtifactDoc} from "@/lib/models/RecordArtifact";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {requireEnv} from "@/lib/env";
import {mongoReconcileRecordDeps, reconcileAnchoredRecord, RECORD_TX_REVERTED_MESSAGE} from "@/lib/records/reconcile";
import {badRequest, notFound, requireVetSession} from "@/lib/staffApi";

/**
 * `POST /api/records/:id/confirm` - the plan's own non-negotiable, verbatim: "confirm is
 * fail-closed (all four chain reads must agree; a receipt is not proof)". Mirrors `api/tags/issue/
 * [sessionId]/confirm/route.ts`'s own shape and tolerance-for-already-reconciled behavior exactly;
 * `reconcileAnchoredRecord` is the shared check (this route, and the worker's boot recovery both
 * call it, so a record whose transaction actually succeeded always has exactly one path to
 * `active`).
 */
export async function POST(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireVetSession();
  if (response) return response;

  const {id: recordId} = await params;
  await connectToDatabase();
  const record = await RecordArtifact.findOne({recordId}).lean<RecordArtifactDoc>();
  if (!record) return notFound("Record not found.");

  if (record.status === "active") {
    // Idempotent - a repeat confirm call on an already-active record simply reports what is
    // already true, mirroring the tag confirm route's own idempotent branch.
    return NextResponse.json({recordId, status: "active", root: record.root, chain: record.chain});
  }
  if (record.status !== "issuing" && record.status !== "error") {
    return badRequest("Only an issuing record can be confirmed.");
  }
  if (!record.chain.operator) {
    return badRequest("This record has no committed operator to confirm against.");
  }

  const settings = await getClinicSettings();
  if (!settings.cloneAddress) return badRequest("This clinic has not completed setup.");

  let factoryAddress: `0x${string}`;
  try {
    factoryAddress = requireEnv("VET_ISSUER_FACTORY_ADDRESS") as `0x${string}`;
  } catch {
    // Missing config must refuse, never silently skip the rootIssuer read - "unwired" is not a
    // state this route can be in by accident (the exact fail-open verify.ts's own rewrite killed).
    return badRequest("This deployment has not configured VET_ISSUER_FACTORY_ADDRESS.");
  }

  const outcome = await reconcileAnchoredRecord(
    {
      recordId,
      root: record.root,
      expectedCloneAddress: settings.cloneAddress,
      expectedOperator: record.chain.operator,
      txHash: record.chain.txHash,
    },
    mongoReconcileRecordDeps(factoryAddress),
  );

  if (outcome.reconciled) {
    return NextResponse.json({recordId, status: "active", root: record.root, contract: outcome.contract});
  }

  if (outcome.reason === "reverted") {
    return NextResponse.json({
      recordId,
      status: "draft",
      root: record.root,
      txHash: undefined,
      lastIssueError: RECORD_TX_REVERTED_MESSAGE,
    });
  }

  if (outcome.reason === "chain-read-failed") {
    // Transient - leave the record exactly as it was so the staff UI can simply retry the confirm
    // call, rather than burning the record into `error` over a flaky RPC call.
    return NextResponse.json({recordId, status: record.status, confirmed: false}, {status: 202});
  }

  // `not-anchored`: only an `issuing` record transitions to `error` here - a record that reached
  // this route already `error` must not have its state clobbered just because the chain still
  // disagrees; it stays exactly as retryable as it was.
  if (record.status === "issuing") {
    await RecordArtifact.updateOne({recordId}, {$set: {status: "error", errorStage: "verify"}});
  }
  return badRequest("On-chain confirmation did not match. The record was not marked active.");
}
