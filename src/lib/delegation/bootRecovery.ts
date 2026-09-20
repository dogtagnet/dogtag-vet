import "server-only";
import {getServerEnv, requireEnv} from "@/lib/env";
import {DelegationSession, type DelegationSessionDoc} from "@/lib/models/DelegationSession";
import {reconcileDelegationWrite} from "@/lib/delegation/reconcile";
import {readDelegationRoot, readIsSecondary, readSecondaryCount, readTxReceiptStatus} from "@/lib/chainRead";

/**
 * Boot recovery for a `DelegationSession` a previous worker process left `"submitting"` when it
 * died mid-flight - mirrors `lib/mint/bootRecovery.ts`'s `recoverInterruptedSessions` (V3's own
 * checklist item: "reconcile worker for stuck sessions"), including that file's own staleness
 * discipline: only a session stale by `DELEGATION_SESSION_STALE_MS` (measured from `submittingAt`,
 * never `createdAt` - a seconds-old in-flight transaction from a process that is still very much
 * alive must be left alone), and a chain re-read BEFORE giving up on any of them (a receipt is not
 * proof, and a session whose write DID land must never be permanently stranded just because the
 * process watching it died).
 *
 * Deliberately reads/writes the `DelegationSession` collection directly rather than through
 * `DelegationFlowStore` - boot recovery is a worker-only concern outside the ceremony's own
 * request/response flow, the same separation `lib/mint/bootRecovery.ts` makes from
 * `lib/mint/flow.ts`'s `MintFlowStore`.
 */
export async function recoverStuckDelegationSessions(): Promise<void> {
  const env = getServerEnv();
  const now = Math.floor(Date.now() / 1000);
  const submittingSessions = await DelegationSession.find({status: "submitting"}).lean<DelegationSessionDoc[]>();
  const staleSessions = submittingSessions.filter(
    (s) => s.submittingAt !== undefined && now - s.submittingAt > env.DELEGATION_SESSION_STALE_MS / 1000,
  );
  if (staleSessions.length === 0) return;

  let delegationRegistryAddress: `0x${string}`;
  try {
    delegationRegistryAddress = requireEnv("DELEGATION_REGISTRY_ADDRESS") as `0x${string}`;
  } catch {
    console.error(`[worker] ${staleSessions.length} stale delegation session(s) found but DELEGATION_REGISTRY_ADDRESS is not configured - cannot reconcile`);
    return;
  }

  const deps = {
    isSecondary: (dogTagIdField: string, commitment: string) => readIsSecondary(delegationRegistryAddress, dogTagIdField, commitment as `0x${string}`),
    secondaryCount: (dogTagIdField: string) => readSecondaryCount(delegationRegistryAddress, dogTagIdField),
    delegationRoot: (dogTagIdField: string) => readDelegationRoot(delegationRegistryAddress, dogTagIdField),
    txReceiptStatus: (txHash: string) => readTxReceiptStatus(txHash as `0x${string}`),
  };

  let reconciledCount = 0;
  let revertedCount = 0;
  let stillWaitingCount = 0;
  for (const session of staleSessions) {
    if (!session.commitment || !session.txHash) continue; // defensive - "submitting" always has both
    try {
      const outcome = await reconcileDelegationWrite(
        {kind: session.kind, dogTagIdField: session.dogTagIdField, commitment: session.commitment, txHash: session.txHash},
        deps,
      );
      if (outcome.reconciled) {
        await DelegationSession.updateOne(
          {registrationId: session.registrationId, status: "submitting"},
          {$set: {status: "confirmed", secondaryCountAtConfirm: outcome.secondaryCount, delegationRootAtConfirm: outcome.delegationRoot}},
        );
        reconciledCount++;
      } else if (outcome.reason === "reverted") {
        await DelegationSession.updateOne(
          {registrationId: session.registrationId, status: "submitting"},
          {$set: {status: "error", errorReason: "Transaction reverted on chain - start a new ceremony."}},
        );
        revertedCount++;
      } else {
        // Still genuinely unreadable, or a receipt that simply never arrives - leave it exactly
        // as it was (never guess "error" over a transient chain-read failure); the staff status
        // poll or a future boot-recovery pass will retry.
        stillWaitingCount++;
      }
    } catch (err) {
      console.error(`[worker] delegation reconcile check failed for stale session ${session.registrationId}`, err);
    }
  }
  if (reconciledCount > 0) {
    console.log(`[worker] reconciled ${reconciledCount} stale submitting delegation session(s) that had actually landed on chain`);
  }
  if (revertedCount > 0) {
    console.log(`[worker] marked ${revertedCount} stale submitting delegation session(s) as reverted`);
  }
  if (stillWaitingCount > 0) {
    console.log(`[worker] left ${stillWaitingCount} stale submitting delegation session(s) unchanged - still inconclusive`);
  }
}
