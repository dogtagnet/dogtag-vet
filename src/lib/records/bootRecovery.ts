import "server-only";
import {getServerEnv, requireEnv} from "@/lib/env";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {RecordArtifact, type RecordArtifactDoc} from "@/lib/models/RecordArtifact";
import {isRecordStale, mongoReconcileRecordDeps, reconcileAnchoredRecord} from "@/lib/records/reconcile";

/**
 * Boot recovery for `RecordArtifact` rows a previous process left `issuing` when it died mid-flight
 * - the record sibling of `lib/mint/bootRecovery.ts`'s `recoverInterruptedSessions` (plan section
 * 11.2 item V3's "a records reconcile in the worker mirroring mint reconcile"). Extracted out of
 * `src/worker/index.ts` for the identical reason: that module's body calls `main()` unconditionally
 * at import time, so importing it anywhere else (a test) would start its live polling loops.
 *
 * Same three-way outcome as the tag side: actually anchored -> reconciled to `active` (with the
 * anchoring metadata); a CONFIRMED revert -> back to `draft` (no `redraft`; the leaves/root are
 * already computed and already verified, so the identical row can retry `issueRecord` immediately);
 * neither (still genuinely unreadable, or a receipt that never arrives) -> `error`/`interrupted`.
 */
export async function recoverInterruptedRecords(): Promise<void> {
  const env = getServerEnv();
  const now = Date.now();
  const issuingRecords = await RecordArtifact.find({status: "issuing"}).lean<RecordArtifactDoc[]>();
  // Reuses MINT_SESSION_STALE_MS rather than a second, record-specific setting: the question this
  // threshold answers ("how long can a submitted-but-unconfirmed on-chain write sit before this
  // process assumes whatever sent it is gone") is identical for a tag's issueTag and a record's
  // issueRecord - same chain, same confirmation latency, same "a live wallet flip can take a few
  // minutes" reasoning `MintSessionDoc.issuingAt`'s own doc comment gives. A dedicated
  // RECORD_SESSION_STALE_MS would only ever be set to the same value in practice.
  const staleRecords = issuingRecords.filter((r) => isRecordStale(r, now, env.MINT_SESSION_STALE_MS));
  if (staleRecords.length === 0) return;

  const settings = await getClinicSettings();
  let factoryAddress: `0x${string}` | undefined;
  try {
    factoryAddress = requireEnv("VET_ISSUER_FACTORY_ADDRESS") as `0x${string}`;
  } catch {
    factoryAddress = undefined;
  }
  const cloneAddress = settings.cloneAddress;

  let reconciledCount = 0;
  let revertedCount = 0;
  let interruptedCount = 0;
  for (const record of staleRecords) {
    let reconciled = false;
    let reverted = false;
    if (factoryAddress && cloneAddress && record.chain.operator) {
      try {
        const outcome = await reconcileAnchoredRecord(
          {
            recordId: record.recordId,
            root: record.root,
            expectedCloneAddress: cloneAddress,
            expectedOperator: record.chain.operator,
            txHash: record.chain.txHash,
          },
          mongoReconcileRecordDeps(factoryAddress),
        );
        reconciled = outcome.reconciled;
        reverted = !outcome.reconciled && outcome.reason === "reverted";
      } catch (err) {
        console.error(`[worker] record-reconcile check failed for stale record ${record.recordId}`, err);
      }
    }
    if (reconciled) {
      reconciledCount++;
    } else if (reverted) {
      revertedCount++;
    } else {
      // Re-check `status: "issuing"` at write time - defensive against this same record being
      // reconciled or confirmed by a concurrent request between this loop's read and this write.
      await RecordArtifact.updateOne({recordId: record.recordId, status: "issuing"}, {$set: {status: "error", errorStage: "interrupted"}});
      interruptedCount++;
    }
  }
  if (reconciledCount > 0) {
    console.log(`[worker] reconciled ${reconciledCount} stale issuing record(s) that had actually anchored on chain`);
  }
  if (revertedCount > 0) {
    console.log(`[worker] reconciled ${revertedCount} stale issuing record(s) whose tx confirmed reverted - back to draft`);
  }
  if (interruptedCount > 0) {
    console.log(`[worker] marked ${interruptedCount} stale issuing record(s) interrupted`);
  }
}
