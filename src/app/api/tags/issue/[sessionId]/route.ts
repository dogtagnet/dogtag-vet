import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {MintSession, type MintSessionDoc} from "@/lib/models/MintSession";
import {BindToken, type BindTokenDoc} from "@/lib/models/BindToken";
import {Pet, type PetDoc} from "@/lib/models/Pet";
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
  // WP4.5 track 3: whether the C3 issuer attestation is ALREADY stored, read straight off the
  // linked Pet (`dogTag.attestation` - the same field `POST .../attestation` writes) rather than
  // any client-local flag - so the wizard's "Sign issuer attestation" button vs. done-badge state
  // survives a reload instead of reverting to offering a signature that was already given and
  // stored (the hot-fixed local-state version's own bug).
  const pet = session.petId ? await Pet.findOne({petId: session.petId}).select("dogTag.attestation").lean<PetDoc>() : null;
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
    lastIssueError: session.lastIssueError,
    // 2026-09-25 incident fix round 2: the LAST reverted issueTag tx, kept for the record
    // (copyable, explorer-linked) next to the "Transaction failed" banner - `failedIssueTxHashes`
    // is an append-only audit trail (`MintSessionDoc`'s own doc comment), so `.at(-1)` is the most
    // recent attempt, matching the one `lastIssueError` itself describes.
    lastFailedTxHash: session.failedIssueTxHashes?.at(-1),
    errorStage: session.errorStage,
    errorReason: session.errorReason,
    attestationSigned: Boolean(pet?.dogTag?.attestation),
    token: latestToken?.consumed ? undefined : latestToken?.token,
    qr: latestToken && !latestToken.consumed ? `${baseUrl.replace(/\/$/, "")}/p/${latestToken.token}` : undefined,
    ttlSecs: latestToken && !latestToken.consumed ? Math.max(0, latestToken.exp - now) : undefined,
  });
}
