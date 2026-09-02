import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {ArtifactExportSession} from "@/lib/models/ArtifactExportSession";
import {findActiveTagArtifact} from "@/lib/tags/artifact";
import {generateHexToken} from "@/lib/models/BindToken";
import {getServerEnv} from "@/lib/env";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

/** How long a generated export QR stays valid - plan 2.2's `now+600s`. */
const EXPORT_TTL_SECS = 600;

/**
 * `POST /api/pets/:id/export-tag-data` - plans/wp4.9-tag-data-custody.md section 2.2. Staff-only,
 * creates a one-time `ArtifactExportSession` for the pet's CURRENTLY active `TagArtifact` (see that
 * model's own doc comment for why `root` is snapshotted here rather than re-read at scan time).
 *
 * Refuses up front (400) rather than handing back a QR doomed to fail the instant it is scanned -
 * `GET /e/:token` would refuse a revoked or missing tag anyway, but there is no reason to make an
 * owner scan a code staff could have been told about immediately, in the same spirit as the
 * wallet-registration route's own precondition checks.
 */
export async function POST(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

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

  const now = Math.floor(Date.now() / 1000);
  const token = generateHexToken();
  const exp = now + EXPORT_TTL_SECS;

  await ArtifactExportSession.create({token, petId, root: artifact.root, exp});

  const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? new URL(request.url).origin;
  const qr = `${baseUrl.replace(/\/$/, "")}/e/${token}`;

  return NextResponse.json({token, qr, ttlSecs: EXPORT_TTL_SECS, issuedAt: now}, {status: 201});
}
