import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {MintSession, type MintSessionDoc} from "@/lib/models/MintSession";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {requireEnv} from "@/lib/env";
import {ISSUE_TX_REVERTED_MESSAGE, mongoReconcileDeps, reconcileAnchoredSession} from "@/lib/mint/reconcile";
import {badRequest, notFound, requireVetSession} from "@/lib/staffApi";

/**
 * `POST /api/tags/issue/:sessionId/confirm` - wp4-vet.md issuance step 5: "the worker (or a
 * server poll) confirms the receipt AND reads back `profileRoot(id) == root` and `isValid(root)`
 * before setting `bound` (a receipt is not proof)". The staff UI calls this right after `wagmi`'s
 * `waitForTransactionReceipt` resolves for the `issueTag` tx - a confirmed receipt on its own is
 * not treated as sufficient; both chain reads below must independently agree.
 *
 * Tolerates a session that is no longer `issuing` but IS actually anchored on chain (round-6 item
 * 3(c)): a worker restart can flip a genuinely-succeeded session to `error`/`interrupted` before
 * this route ever gets to confirm it itself (see `src/worker/index.ts`'s boot recovery). Calling
 * confirm again on such a session reconciles it to `bound` instead of refusing - the same shared
 * check `reconcileAnchoredSession` gives the worker and the retry route, so this is one more path
 * to the same outcome, not a second implementation of it.
 */
export async function POST(request: Request, {params}: {params: Promise<{sessionId: string}>}) {
  const {response} = await requireVetSession();
  if (response) return response;

  const {sessionId} = await params;
  await connectToDatabase();
  const session = await MintSession.findOne({sessionId}).lean<MintSessionDoc>();
  if (!session) return notFound("Mint session not found.");

  if (session.status === "bound") {
    // Idempotent: a repeat confirm call (a double click, a retried request after a dropped
    // response) on an already-bound session simply reports what is already true.
    return NextResponse.json({sessionId, status: "bound", dogTagId: session.dogTagIdDec, root: session.root, txHash: session.txHash});
  }
  if (!session.root || (session.status !== "issuing" && session.status !== "error")) {
    return badRequest("Only an issuing session with a sealed root can be confirmed.");
  }

  const settings = await getClinicSettings();
  if (!settings.cloneAddress) return badRequest("This clinic has not completed setup.");

  let sbtAddress: `0x${string}`;
  try {
    sbtAddress = requireEnv("DOGTAG_SBT_ADDRESS") as `0x${string}`;
  } catch {
    return badRequest("This clinic has not completed setup.");
  }

  const cloneAddress = settings.cloneAddress as `0x${string}`;
  const outcome = await reconcileAnchoredSession(session, cloneAddress, mongoReconcileDeps(sbtAddress, cloneAddress));

  if (outcome.reconciled) {
    return NextResponse.json({sessionId, status: "bound", dogTagId: outcome.dogTagIdDec, root: outcome.root, txHash: session.txHash});
  }

  if (outcome.reason === "reverted") {
    // The receipt itself is conclusive (WP4.5 track 3's proven forensic case) - back to `ready`,
    // never `error`: the device's profile tree is still bound and the id's root was never
    // anchored, so the SAME session can retry `issueTag` immediately with no new token/QR round
    // trip. `markSessionRevertedReady` (inside reconcileAnchoredSession) already persisted this;
    // this response just reflects it back without waiting for the wizard's next poll tick.
    return NextResponse.json({
      sessionId,
      status: "ready",
      dogTagId: session.dogTagIdDec,
      root: session.root,
      txHash: undefined,
      lastIssueError: ISSUE_TX_REVERTED_MESSAGE,
      // The tx that just confirmed reverted IS the one markSessionRevertedReady just pushed onto
      // failedIssueTxHashes - returned here so the wizard can show it immediately (copyable,
      // explorer-linked) without waiting for the next 2s poll tick to re-fetch it.
      lastFailedTxHash: session.txHash,
    });
  }

  if (outcome.reason === "chain-read-failed") {
    // A transient read failure is neither confirmed nor refused permanently - leave the session
    // exactly as it was so the staff UI can simply retry the confirm call, rather than burning the
    // tag into `error` over a flaky RPC call.
    return NextResponse.json({sessionId, status: session.status, confirmed: false}, {status: 202});
  }

  // `not-anchored`: only an `issuing` session transitions to `error` here - a session that reached
  // this route already `error` (the case this tolerance exists for) must not have its state
  // clobbered just because the chain still disagrees; it stays exactly as retryable as it was.
  if (session.status === "issuing") {
    await MintSession.updateOne({sessionId}, {$set: {status: "error", errorStage: "verify"}});
  }
  return badRequest("On-chain confirmation did not match. The tag was not marked bound.");
}
