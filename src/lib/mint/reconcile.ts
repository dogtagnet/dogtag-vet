import "server-only";
import {MintSession} from "@/lib/models/MintSession";
import {Pet} from "@/lib/models/Pet";
import {readIsValidRoot, readProfileRoot, readTxReceiptStatus} from "@/lib/chainRead";
import {activateAnchoredArtifact} from "@/lib/tags/artifact";

/** Surfaced verbatim in the wizard's "ready" banner and persisted as the session's own
 * `lastIssueError` - see `MintSessionDoc.lastIssueError`'s doc comment. */
export const ISSUE_TX_REVERTED_MESSAGE = "Transaction reverted on chain - you can issue again.";

/**
 * The fields `reconcileAnchoredSession` needs from a `MintSessionDoc` - deliberately a narrow
 * structural type (not `MintSessionDoc` itself) so the pure function below stays independent of
 * mongoose, exactly like `lib/mint/flow.ts`'s `MintSessionRow`/`MintFlowStore` split does for the
 * rest of the mint flow.
 */
export interface ReconcileSessionInput {
  sessionId: string;
  dogTagIdDec: string;
  dogTagIdField: string;
  root?: string;
  petId?: string;
  txHash?: string;
}

export interface LinkedDogTag {
  dogTagIdDec: string;
  dogTagIdField: string;
  root: string;
  issuedTx?: string;
  cloneAddress: string;
}

/** Everything `reconcileAnchoredSession` needs to do its one job, injected so it can be unit
 * tested against an in-memory fake (both the chain reads AND the two persistence writes) with no
 * live database and no RPC - the same dependency-injection shape `lib/booking/book.ts`'s
 * `BookingStore` and `lib/mint/flow.ts`'s `MintFlowStore` already use for this exact reason. */
export interface ReconcileDeps {
  /** `DogTagSBTConsent.profileRoot(dogTagIdField)` for this session's id. */
  readProfileRoot(dogTagIdFieldDec: string): Promise<string>;
  /** `VetIssuer.isValid(root)` on the clinic's clone. */
  readIsValidRoot(root: string): Promise<boolean>;
  /** The `issueTag` transaction's own receipt status, read directly rather than inferred from
   * `readProfileRoot`/`readIsValidRoot` disagreeing - see `reconcileAnchoredSession`'s doc comment
   * on why a confirmed revert gets its own signal instead of falling through to `not-anchored`.
   * `"pending"` covers both "not yet mined" and "no receipt to check" (no txHash on the session). */
  readTxReceiptStatus(txHash: string): Promise<"success" | "reverted" | "pending">;
  /** Marks the session `bound`. Idempotent - only ever called after a fresh chain read confirms
   * the anchor, so calling it again for an already-`bound` session is harmless. */
  markSessionBound(sessionId: string): Promise<void>;
  /** The SAME terminal write `POST /api/tags/issue/:sessionId/confirm` always performed on a
   * normal (non-recovery) success: links the tag onto the Pet record. No-ops when the session has
   * no `petId`. */
  linkPetDogTag(petId: string, tag: LinkedDogTag): Promise<void>;
  /** The `issueTag` tx confirmed-reverted recovery write (WP4.5 track 3 - the proven forensic
   * case): flips the session back to `ready` (never `error` - the device already bound the
   * profile tree and the root was never anchored, so the SAME session can retry `issueTag`
   * immediately with no new token/QR round trip), records `lastIssueError`, and keeps the failed
   * tx in the session's audit history rather than dropping it. */
  markSessionRevertedReady(sessionId: string, txHash: string): Promise<void>;
}

export type ReconcileOutcome =
  | {reconciled: true; dogTagIdDec: string; root: string}
  | {reconciled: false; reason: "no-root" | "chain-read-failed" | "not-anchored"}
  | {reconciled: false; reason: "reverted"; txHash: string};

/**
 * Was this session's tag actually anchored on chain, even though the LOCAL record does not (yet,
 * or any more) say `bound`? wp4-vet.md issuance step 5's own confirmation contract - "reads back
 * `profileRoot(id) == root` and `isValid(root)` before setting `bound` (a receipt is not proof)" -
 * applies identically no matter who is asking: the staff UI polling right after its own `issueTag`
 * tx, the worker checking a session a crashed process left stranded at boot, or an operator
 * manually retrying a session the worker wrongly marked `error`. Three call sites (the confirm
 * route, the retry route, and the worker's boot recovery) share this one implementation so a
 * session whose transaction actually succeeded always has exactly one path back to `bound` -
 * see each call site's own doc comment for why it needed this.
 *
 * A session with a recorded `txHash` gets ONE MORE check before any of that: the receipt's own
 * status, read directly. Proven forensic case (wp4.5-track3-mint-plan.md): `issueTag`'s ENTIRE
 * body can succeed on chain (the SBT mint, the `TagIssued` event) and the transaction can still
 * revert afterward (an OutOfGas in the refund tail) - a full revert undoes every state change, so
 * `readProfileRoot` reads back unset and this would otherwise fall into the generic `not-anchored`
 * branch below. That branch answers to sessions still awaiting confirmation just as much as
 * sessions that are provably dead, so it cannot tell a live wallet flip a `not-anchored` verdict
 * apart from a confirmed-dead transaction - and a live wallet flip is exactly the profileRoot read
 * a `pending`/not-yet-mined tx also produces. A CONFIRMED revert is different: there is nothing
 * left to wait for, so it gets its own signal and its own recovery (`markSessionRevertedReady`)
 * instead of the `error`/`errorStage: "verify"` a caller might otherwise apply to `not-anchored`.
 */
export async function reconcileAnchoredSession(
  session: ReconcileSessionInput,
  cloneAddress: string,
  deps: ReconcileDeps,
): Promise<ReconcileOutcome> {
  if (!session.root) return {reconciled: false, reason: "no-root"};

  if (session.txHash) {
    let receiptStatus: "success" | "reverted" | "pending";
    try {
      receiptStatus = await deps.readTxReceiptStatus(session.txHash);
    } catch {
      return {reconciled: false, reason: "chain-read-failed"};
    }
    if (receiptStatus === "reverted") {
      await deps.markSessionRevertedReady(session.sessionId, session.txHash);
      return {reconciled: false, reason: "reverted", txHash: session.txHash};
    }
  }

  let onChainRoot: string;
  let valid: boolean;
  try {
    onChainRoot = await deps.readProfileRoot(session.dogTagIdField);
    valid = await deps.readIsValidRoot(session.root);
  } catch {
    // Fail-closed, same as every other chain read in this app (chainRead.ts's doc comment): an
    // unreadable chain is neither "anchored" nor "not anchored" - callers treat this as transient
    // and leave the session's current state untouched rather than guessing either way.
    return {reconciled: false, reason: "chain-read-failed"};
  }

  if (onChainRoot.toLowerCase() !== session.root.toLowerCase() || !valid) {
    return {reconciled: false, reason: "not-anchored"};
  }

  await deps.markSessionBound(session.sessionId);
  if (session.petId) {
    await deps.linkPetDogTag(session.petId, {
      dogTagIdDec: session.dogTagIdDec,
      dogTagIdField: session.dogTagIdField,
      root: session.root,
      issuedTx: session.txHash,
      cloneAddress,
    });
  }

  return {reconciled: true, dogTagIdDec: session.dogTagIdDec, root: session.root};
}

/**
 * The terminal "seal this tag onto a Pet record" write - shared by every caller that ever needs to
 * do this: the normal mint confirm route, this file's own reconciliation recovery paths (via
 * `mongoReconcileDeps` below), and WP4.4's tier-3 staff relink action
 * (`lib/booking/relinkDogTag.ts`, "issued_here_unlinked": a root this clinic issued exists on
 * chain but no local Pet record carries it, typically after a DB restore). One implementation
 * means every caller seals a tag onto a pet in EXACTLY the same shape - never a second, slightly
 * different write path a future reader has to notice and reconcile by hand.
 *
 * WP4.9V FIX ROUND 1 (D3): this is also, for that exact reason, the ONE place a `TagArtifact` is
 * ever promoted to `active` - see `activateAnchoredArtifact`'s own doc comment. `Pet.dogTag.root`
 * is written first: if the process dies between the two writes below, the pet is left with its new
 * root recorded but no matching ACTIVE artifact yet (never the reverse - an active artifact for a
 * root the pet record does not yet claim), which is the same fail-closed shape
 * `createTagArtifact`'s own doc comment already prefers, and which the export route's own
 * `artifact.root === pet.dogTag.root` guard (`export-tag-data/route.ts`) and the backfill runbook
 * both already handle.
 *
 * WP4.9V FIX ROUND 2 (N1): the artifact promotion below is wrapped in try/catch, mirroring
 * `applyIssuedArtifactSideEffect`'s own "never throw" contract exactly - the `Pet.updateOne` above
 * has already durably confirmed the on-chain anchor onto the pet record by the time this runs, so a
 * transient failure promoting the `TagArtifact` row must never turn that genuine confirmation into a
 * thrown error back through `reconcileAnchoredSession`'s callers (the confirm route, the retry route,
 * the worker's boot recovery, and WP4.4 tier-3's relink action all call this function unwrapped). A
 * failure here is only ever logged: the backfill runbook (docs/DEPLOY.md) is the documented repair
 * path for the pet this leaves without a matching active artifact.
 */
export async function linkPetDogTag(petId: string, tag: LinkedDogTag): Promise<void> {
  await Pet.updateOne(
    {petId},
    {
      $set: {
        "dogTag.dogTagIdDec": tag.dogTagIdDec,
        "dogTag.dogTagIdField": tag.dogTagIdField,
        "dogTag.root": tag.root,
        "dogTag.status": "active",
        "dogTag.issuedTx": tag.issuedTx,
        "dogTag.cloneAddress": tag.cloneAddress,
        "dogTag.issuedAt": new Date(),
      },
    },
  );
  try {
    await activateAnchoredArtifact(petId, tag.root);
  } catch (err) {
    // Never turn a genuine on-chain confirmation into a failed response - the pet is already linked
    // above; a missing promotion is the fail-closed shape docs/DEPLOY.md's backfill runbook repairs
    // (it now reactivates, per FIX ROUND 1 D1).
    console.error(`could not promote the anchored TagArtifact for pet ${petId} root ${tag.root}:`, err);
  }
}

/** Mongoose + real-chain `ReconcileDeps` - the production adapter shared by every call site. */
export function mongoReconcileDeps(sbtAddress: `0x${string}`, cloneAddress: `0x${string}`): ReconcileDeps {
  return {
    readProfileRoot: (dogTagIdFieldDec) => readProfileRoot(sbtAddress, dogTagIdFieldDec),
    readIsValidRoot: (root) => readIsValidRoot(cloneAddress, root as `0x${string}`),
    readTxReceiptStatus: (txHash) => readTxReceiptStatus(txHash as `0x${string}`),
    async markSessionBound(sessionId) {
      await MintSession.updateOne(
        {sessionId},
        {$set: {status: "bound", resolvedAt: new Date()}, $unset: {errorStage: "", errorReason: ""}},
      );
    },
    linkPetDogTag,
    async markSessionRevertedReady(sessionId, txHash) {
      // `$unset` the now-dead txHash/issuingAt (never displayed as if it were the session's live
      // tx - the failed attempt lives on in `failedIssueTxHashes` for the audit trail instead) and
      // clear any stale errorStage/errorReason from a PRIOR round, mirroring markSessionBound's own
      // cleanup - a session bouncing error -> ready -> issuing -> reverted -> ready must not still
      // be carrying an errorStage from two attempts ago.
      await MintSession.updateOne(
        {sessionId},
        {
          $set: {status: "ready", lastIssueError: ISSUE_TX_REVERTED_MESSAGE},
          $unset: {txHash: "", issuingAt: "", errorStage: "", errorReason: ""},
          $push: {failedIssueTxHashes: txHash},
        },
      );
    },
  };
}

/** The age guard for the worker's boot recovery (wp4-vet.md's own word for this: "stale"). A
 * session's clock starts the moment it actually enters `issuing` (`issuingAt`, stamped by
 * `POST .../tx`), never `createdAt` - a session can sit `pending` for minutes waiting on the
 * owner's phone before ever reaching `issuing`, so `createdAt` would count that ordinary wait
 * against the threshold and flip a transaction that has been in flight for mere seconds. Sessions
 * from before `issuingAt` existed fall back to `createdAt` rather than being treated as
 * infinitely fresh (or crashing on a missing field). */
export function isMintSessionStale(
  session: {issuingAt?: Date | string; createdAt: Date | string},
  nowMs: number,
  staleMs: number,
): boolean {
  const enteredIssuingAtMs = new Date(session.issuingAt ?? session.createdAt).getTime();
  return nowMs - enteredIssuingAtMs >= staleMs;
}
