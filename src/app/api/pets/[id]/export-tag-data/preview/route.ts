import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {findActiveTagArtifact} from "@/lib/tags/artifact";
import {buildRedactedExportPayload} from "@/lib/tags/exportFlow";
import {validateExportMask} from "@/lib/tags/exportMask";
import {exportMaskRequestSchema} from "@/lib/schemas/tagExport";
import {roax} from "@/lib/chains";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

/**
 * `POST /api/pets/:id/export-tag-data/preview` - WP4.10V item 4's "Download JSON"/"Copy JSON"
 * actions. Staff-only, produces the EXACT `RedactedTagArtifact`-shaped payload a masked `GET
 * /e/{token}` fetch would eventually return, but WITHOUT minting or consuming any one-time
 * `ArtifactExportSession` token - there is nothing for a one-time ceremony to protect here (staff
 * already has full, standing access to this pet's own already-custodied data; this action never
 * hands anything to a device that did not already have it).
 *
 * Deliberately NOT implemented as "mint a session, then fetch its `/e/:token` URL": that URL is
 * served under `PUBLIC_BASE_URL`, which a real deployment often points at a DIFFERENT origin than
 * the vet portal staff are browsing (a phone-facing tunnel vs. `localhost`/the app's own origin -
 * MANUAL-E2E.md's own environment table). A same-page `fetch()` across that boundary would either
 * hit CORS (no `Access-Control-Allow-Origin` is set on that route - it is meant for a phone's
 * native scan or a direct browser navigation, never a cross-origin page script) or, worse, silently
 * BURN the one-time token via the request while the browser is blocked from ever reading the
 * response body. Building the SAME payload directly, in-process, via the shared
 * `buildRedactedExportPayload` (never a second, independently-maintained copy of the redaction
 * logic) sidesteps that failure mode entirely - same-origin, staff-authenticated, no token at all.
 */
export async function POST(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

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

  const artifact = await findActiveTagArtifact(petId);
  if (!artifact) {
    return badRequest("This pet has no tag data on file yet - issue or import a tag first.");
  }

  if (mask.length > 0) {
    const maskErrors = validateExportMask(mask, artifact.leaves.map((l) => l.keyPath));
    if (maskErrors.length > 0) {
      return badRequest("One or more fields cannot be masked.", {fieldErrors: {mask: maskErrors}});
    }
  }

  // `.lean()` never applies a schema default - a legacy row written before this field existed
  // reads back with the key genuinely absent (`TagArtifactDoc.obfuscatedLeafHashes`'s own doc
  // comment). Normalized to `[]` right here, the same boundary `exportMongoAdapter.ts`'s own
  // `toExportedArtifactRow` normalizes it at for the ceremony route.
  const built = buildRedactedExportPayload({...artifact, obfuscatedLeafHashes: artifact.obfuscatedLeafHashes ?? []}, mask);
  if (!built.ok) {
    // Same defensive posture as the ceremony route's own self-check - a server bug, never a staff
    // input problem (the mask already passed validateExportMask above).
    console.error(`export-tag-data preview self-check failed for petId=${petId} root=${artifact.root} (mask=${JSON.stringify(mask)}).`);
    return NextResponse.json(
      {error: {code: "internal_error", message: "Something went wrong preparing this tag's data."}},
      {status: 500},
    );
  }

  const settings = await getClinicSettings();
  return NextResponse.json({
    ...built.data,
    chainId: roax.id,
    petName: pet.name,
    clinicName: settings.businessProfile?.name?.trim() || "",
  });
}
