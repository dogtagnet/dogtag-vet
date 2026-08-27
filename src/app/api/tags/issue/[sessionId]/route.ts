import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {MintSession, type MintSessionDoc} from "@/lib/models/MintSession";
import {BindToken, type BindTokenDoc} from "@/lib/models/BindToken";
import {notFound, requireStaffSession} from "@/lib/staffApi";
import {getServerEnv} from "@/lib/env";

/** `GET /api/tags/issue/:sessionId` - staff poll of a mint session's full state (unlike the
 * device-facing `/p/:token/status`, this includes `errorReason` and every field the wizard needs
 * to keep rendering the same session across a page reload). */
export async function GET(request: Request, {params}: {params: Promise<{sessionId: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {sessionId} = await params;
  await connectToDatabase();
  const session = await MintSession.findOne({sessionId}).lean<MintSessionDoc>();
  if (!session) return notFound("Mint session not found.");

  const latestToken = await BindToken.findOne({sessionId}).sort({_id: -1}).lean<BindTokenDoc>();
  const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? new URL(request.url).origin;
  const now = Math.floor(Date.now() / 1000);

  return NextResponse.json({
    sessionId: session.sessionId,
    dogTagId: session.dogTagIdDec,
    dogTagIdField: session.dogTagIdField,
    petId: session.petId,
    petName: session.petName,
    status: session.status,
    root: session.root,
    txHash: session.txHash,
    errorStage: session.errorStage,
    errorReason: session.errorReason,
    token: latestToken?.consumed ? undefined : latestToken?.token,
    qr: latestToken && !latestToken.consumed ? `${baseUrl.replace(/\/$/, "")}/p/${latestToken.token}` : undefined,
    ttlSecs: latestToken && !latestToken.consumed ? Math.max(0, latestToken.exp - now) : undefined,
  });
}
