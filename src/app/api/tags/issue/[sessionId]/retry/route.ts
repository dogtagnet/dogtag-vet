import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {MintSession, type MintSessionDoc} from "@/lib/models/MintSession";
import {BindToken, generateHexToken} from "@/lib/models/BindToken";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";
import {preflightIssuance} from "@/lib/mint/preflight";
import {ISSUE_TX_REVERTED_MESSAGE, mongoReconcileDeps, reconcileAnchoredSession} from "@/lib/mint/reconcile";
import {getServerEnv, requireEnv} from "@/lib/env";
import {hexAddress} from "@/lib/schemas/common";

const TOKEN_TTL_SECS = 600;

/**
 * `POST /api/tags/issue/:sessionId/retry` - wp4-vet.md issuance step 7: re-arms a failed session
 * keeping the SAME dogTagId and identity leaves, issuing a fresh token. Re-runs the same
 * preflight as `start` (a wallet can lose its whitelist status between attempts) but never
 * touches the dogTagId counter - the whole point of retry is that the id is already safely
 * reserved and its root is (by construction of every failure path that reaches `error`) still
 * unset on chain.
 *
 * That last assumption is exactly what a session recovered from a worker restart (or one
 * re-checked here) can violate: `errorStage: "issue"`/`"verify"`/`"interrupted"` are only reached
 * AFTER a root was already sealed (`session.root` set), and if that root's `issueTag` transaction
 * actually landed on chain, the id's root is anchored FOREVER - re-arming would `$unset` `root`
 * and hand out a fresh token whose eventual `custodial-bind` can never seal (its own
 * `isRootStillUnset` re-check will always read false), permanently stranding the tag in
 * `seal_conflict`. So before re-arming anything, check whether that already happened -
 * `reconcileAnchoredSession`, the same check the worker's boot recovery and the confirm route
 * use - and short-circuit straight to `bound` if so, rather than manufacturing a retry that can
 * never succeed.
 */
export async function POST(request: Request, {params}: {params: Promise<{sessionId: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {sessionId} = await params;
  const body = await request.json().catch(() => null);
  const parsedOperator = hexAddress.safeParse((body as {operatorAddress?: unknown})?.operatorAddress);
  if (!parsedOperator.success) return badRequest("operatorAddress is required.");

  await connectToDatabase();
  const session = await MintSession.findOne({sessionId}).lean<MintSessionDoc>();
  if (!session) return notFound("Mint session not found.");
  if (session.status !== "error") {
    return badRequest("Only a session in error can be retried.");
  }

  if (session.root) {
    const settings = await getClinicSettings();
    let sbtAddress: `0x${string}` | undefined;
    try {
      sbtAddress = requireEnv("DOGTAG_SBT_ADDRESS") as `0x${string}`;
    } catch {
      sbtAddress = undefined;
    }
    if (sbtAddress && settings.cloneAddress) {
      const cloneAddress = settings.cloneAddress as `0x${string}`;
      const outcome = await reconcileAnchoredSession(session, cloneAddress, mongoReconcileDeps(sbtAddress, cloneAddress));
      if (outcome.reconciled) {
        return NextResponse.json({sessionId, status: "bound", dogTagId: outcome.dogTagIdDec, root: outcome.root});
      }
      if (!outcome.reconciled && outcome.reason === "reverted") {
        // Same reasoning as the confirm route: a confirmed revert means the root was never
        // anchored, so this session can go straight back to `ready` (retry `issueTag` with the
        // SAME token-free session) instead of this route's own "arm a fresh bind token" path below
        // - which would needlessly discard an already-bound profile tree and make the owner redo
        // the QR ceremony for no reason.
        return NextResponse.json({
          sessionId,
          status: "ready",
          dogTagId: session.dogTagIdDec,
          root: session.root,
          lastIssueError: ISSUE_TX_REVERTED_MESSAGE,
        });
      }
    }
  }

  const preflight = await preflightIssuance(parsedOperator.data as `0x${string}`);
  if (!preflight.ok) return badRequest(preflight.message);

  const now = Math.floor(Date.now() / 1000);
  const tokenExp = now + TOKEN_TTL_SECS;
  await MintSession.updateOne(
    {sessionId},
    {
      $set: {status: "pending", tokenExp},
      $unset: {errorStage: "", errorReason: "", root: "", boundLeaves: "", reservedLeafHashes: "", txHash: "", firstResolvedAt: ""},
    },
  );
  const token = generateHexToken();
  await BindToken.create({token, sessionId, exp: tokenExp, consumed: false});

  const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? new URL(request.url).origin;
  return NextResponse.json({
    token,
    dogTagId: session.dogTagIdDec,
    sessionId,
    qr: `${baseUrl.replace(/\/$/, "")}/p/${token}`,
    ttlSecs: TOKEN_TTL_SECS,
  });
}
