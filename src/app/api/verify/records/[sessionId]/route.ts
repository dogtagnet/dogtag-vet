import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {RecordVerifySession, type RecordVerifySessionDoc} from "@/lib/models/RecordVerifySession";
import {notFound, requireStaffSession} from "@/lib/staffApi";

/**
 * `GET /api/verify/records/:sessionId` - staff's poll target while the QR from `.../start` is
 * outstanding, mirroring `GET /api/verify/:sessionId`'s own polling role for the ZK-consent flow.
 * The result staff sees here is the SAME `RecordVerifyStoredResult` `POST /v/:token/complete` wrote
 * server-side - never re-derived from (or trusted from) whatever the phone itself displayed.
 */
export async function GET(_request: Request, {params}: {params: Promise<{sessionId: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {sessionId} = await params;
  await connectToDatabase();
  const session = await RecordVerifySession.findOne({sessionId}).lean<RecordVerifySessionDoc>();
  if (!session) return notFound("Verification session not found.");

  return NextResponse.json({
    sessionId: session.sessionId,
    status: session.status,
    result: session.result,
    exp: session.exp,
  });
}
