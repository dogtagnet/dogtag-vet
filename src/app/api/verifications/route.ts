import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {VerifySession, type VerifySessionDoc} from "@/lib/models/VerifySession";
import {requireStaffSession} from "@/lib/staffApi";

/** `GET /api/verifications` - the `/verifications` history page. v1 `VerificationLog` vocabulary:
 * stores disclosed keyPaths never values, and never a subject wallet - `VerifySessionDoc` already
 * has no such field to accidentally leak, but the projection below is explicit about it anyway so
 * this route stays correct even if the document shape grows a field later. */
export async function GET() {
  const {response} = await requireStaffSession();
  if (response) return response;

  await connectToDatabase();
  const sessions = await VerifySession.find({status: "recorded"})
    .sort({updatedAt: -1})
    .limit(200)
    .select("sessionId purpose recordType relayerAddress challenge txHash nullifier disclosedKeyPaths appointmentId clientId petId createdAt updatedAt")
    .lean<VerifySessionDoc[]>();

  return NextResponse.json(sessions);
}
