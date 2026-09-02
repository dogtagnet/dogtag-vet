import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {ArtifactExportSession} from "@/lib/models/ArtifactExportSession";
import {findActiveTagArtifact} from "@/lib/tags/artifact";
import {validateExportMask} from "@/lib/tags/exportMask";
import {exportMaskRequestSchema} from "@/lib/schemas/tagExport";
import {generateHexToken} from "@/lib/models/BindToken";
import {getServerEnv} from "@/lib/env";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

/** How long a generated export QR stays valid - plan 2.2's `now+600s`. */
const EXPORT_TTL_SECS = 600;

/**
 * `POST /api/pets/:id/export-tag-data` - plans/wp4.9-tag-data-custody.md section 2.2, generalized
 * by WP4.10V item 3 to accept an optional `{mask?: string[]}` body. Staff-only, creates a one-time
 * `ArtifactExportSession` for the pet's CURRENTLY active `TagArtifact` (see that model's own doc
 * comment for why `root` is snapshotted here rather than re-read at scan time).
 *
 * `mask` (a list of keyPaths to obfuscate) is validated against THIS artifact's own disclosed leaf
 * keyPaths (`validateExportMask` - unknown keyPath or a duplicate is a 400 field error; there is no
 * "non-maskable" rejection reason, WP4.10S's own evidence-based ruling that the non-maskable set is
 * empty). An absent or empty `mask` is an ordinary, fully-disclosed export - the pre-WP4.10V
 * default, unchanged for every existing caller that posts no body at all.
 *
 * Refuses up front (400) rather than handing back a QR doomed to fail the instant it is scanned -
 * `GET /e/:token` would refuse a revoked or missing tag anyway, but there is no reason to make an
 * owner scan a code staff could have been told about immediately, in the same spirit as the
 * wallet-registration route's own precondition checks.
 */
export async function POST(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  // No body at all (every pre-WP4.10V caller) parses to {} here, never a 400 - `.catch` only
  // covers "not valid JSON at all" (including empty), never a genuinely malformed non-empty body,
  // which `exportMaskRequestSchema.safeParse` below still catches and reports as a field error.
  const body = await request.json().catch(() => ({}));
  const parsedBody = exportMaskRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return badRequest("Malformed export request.", parsedBody.error.flatten());
  }
  const mask = parsedBody.data.mask ?? [];

  const {id: petId} = await params;
  await connectToDatabase();
  const pet = await Pet.findOne({petId}).lean<PetDoc>();
  if (!pet) return notFound("Pet not found.");

  if (pet.dogTag?.status === "revoked") {
    return badRequest("This pet's tag is revoked - there is no active tag data to share.");
  }

  const artifact = await findActiveTagArtifact(petId);
  if (!artifact) {
    return badRequest("This pet has no tag data on file yet - issue or import a tag first.");
  }

  // WP4.9V FIX ROUND 1 (D3), belt-and-suspenders: `lib/mint/reconcile.ts::linkPetDogTag` is now the
  // only place an `issued_here` artifact is ever promoted to `active`, exactly when the chain
  // confirms `pet.dogTag.root` - so this mismatch should never actually happen. It is checked
  // anyway, explicitly, rather than trusted implicitly: a pet whose "active" artifact's root
  // diverges from its own anchored `dogTag.root` (a mid-reissue window, a stale relink, any future
  // write path that forgets this invariant) must refuse rather than hand an owner's phone data for
  // a root that is not what is actually on chain for this pet.
  if (artifact.root !== pet.dogTag?.root?.toLowerCase()) {
    return badRequest("This pet's tag data is mid-reissue and not yet anchored on chain - try again once the reissue completes or is retried.");
  }

  if (mask.length > 0) {
    const maskErrors = validateExportMask(mask, artifact.leaves.map((l) => l.keyPath));
    if (maskErrors.length > 0) {
      return badRequest("One or more fields cannot be masked.", {fieldErrors: {mask: maskErrors}});
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const token = generateHexToken();
  const exp = now + EXPORT_TTL_SECS;

  await ArtifactExportSession.create({token, petId, root: artifact.root, exp, mask: mask.length > 0 ? mask : undefined});

  const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? new URL(request.url).origin;
  const qr = `${baseUrl.replace(/\/$/, "")}/e/${token}`;

  return NextResponse.json({token, qr, ttlSecs: EXPORT_TTL_SECS, issuedAt: now}, {status: 201});
}
