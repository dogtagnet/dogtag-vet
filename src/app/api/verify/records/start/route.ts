import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {RecordVerifySession} from "@/lib/models/RecordVerifySession";
import {generateHexToken} from "@/lib/models/BindToken";
import {getServerEnv} from "@/lib/env";
import {requireStaffSession} from "@/lib/staffApi";

/** `/v/<token>` QR TTL - the plan's own explicit "TTL 600s" for this ceremony. */
const RECORD_VERIFY_TTL_SECS = 600;

/**
 * `POST /api/verify/records/start` - plan section 11.2 V6's "Records mode" on `/verify`. Staff-only
 * (the same `requireStaffSession` gate `/api/verify/start`'s own ZK-consent flow uses - asking
 * someone to present a vaccination record is a lookup/check action, never a privileged issuance one,
 * so this never needs the stricter vet/owner gate issuance routes carry).
 *
 * No pet/record is picked in advance, deliberately: unlike the export ceremony (staff already knows
 * exactly which of ITS OWN already-issued records it is sharing), this ceremony is a BLIND
 * presentment - the whole point of a portable, independently-verifiable credential is that any
 * verifier can check any presented record without knowing in advance which one it will be (a new
 * clinic checking a visiting pet's rabies proof, say). The session carries no petId/recordId at
 * all - `lib/records/verifier.ts`'s pipeline resolves everything it needs directly from whatever
 * artifact the phone eventually posts.
 */
export async function POST(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  await connectToDatabase();
  const now = Math.floor(Date.now() / 1000);
  const token = generateHexToken();
  const session = await RecordVerifySession.create({token, purpose: "RECORD_PRESENT", exp: now + RECORD_VERIFY_TTL_SECS, status: "pending"});

  const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? new URL(request.url).origin;
  const qr = `${baseUrl.replace(/\/$/, "")}/v/${token}`;

  return NextResponse.json({sessionId: session.sessionId, token, qr, ttlSecs: RECORD_VERIFY_TTL_SECS, issuedAt: now}, {status: 201});
}
