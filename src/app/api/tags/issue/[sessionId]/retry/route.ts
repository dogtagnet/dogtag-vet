import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {MintSession, type MintSessionDoc} from "@/lib/models/MintSession";
import {BindToken, generateHexToken} from "@/lib/models/BindToken";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";
import {preflightIssuance} from "@/lib/mint/preflight";
import {getServerEnv} from "@/lib/env";
import {hexAddress} from "@/lib/schemas/common";

const TOKEN_TTL_SECS = 600;

/**
 * `POST /api/tags/issue/:sessionId/retry` - wp4-vet.md issuance step 7: re-arms a failed session
 * keeping the SAME dogTagId and identity leaves, issuing a fresh token. Re-runs the same
 * preflight as `start` (a wallet can lose its whitelist status between attempts) but never
 * touches the dogTagId counter - the whole point of retry is that the id is already safely
 * reserved and its root is (by construction of every failure path that reaches `error`) still
 * unset on chain.
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
