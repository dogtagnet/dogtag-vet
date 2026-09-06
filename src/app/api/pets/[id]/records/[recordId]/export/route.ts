import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {ArtifactExportSession} from "@/lib/models/ArtifactExportSession";
import {findRecordArtifact} from "@/lib/records/artifact";
import {validateRecordExportMask} from "@/lib/records/exportMask";
import {recordExportMaskRequestSchema} from "@/lib/schemas/recordExport";
import {generateHexToken} from "@/lib/models/BindToken";
import {getServerEnv} from "@/lib/env";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

/** How long a generated export QR stays valid - matches `export-tag-data`'s own `EXPORT_TTL_SECS`. */
const EXPORT_TTL_SECS = 600;

/**
 * `POST /api/pets/:id/records/:recordId/export` - plan section 11.2 V5, the record sibling of
 * `api/pets/[id]/export-tag-data/route.ts`. Staff-only, creates a one-time `ArtifactExportSession`
 * (`artifactType: "record"`, `recordId` set) for exactly this record's CURRENT root.
 *
 * `mask` is validated against BOTH this record's own disclosed leaf keyPaths AND its snapshotted
 * `nonMaskable` set (`validateRecordExportMask`) - unlike the tag side, a `"non_maskable"` rejection
 * reason genuinely exists here (the plan's own non-negotiable: "the non-maskable set ... is locked
 * in the export UI AND enforced server-side").
 */
export async function POST(request: Request, {params}: {params: Promise<{id: string; recordId: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const body = await request.json().catch(() => ({}));
  const parsedBody = recordExportMaskRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return badRequest("Malformed export request.", parsedBody.error.flatten());
  }
  const mask = parsedBody.data.mask ?? [];

  const {id: petId, recordId} = await params;
  await connectToDatabase();
  const pet = await Pet.findOne({petId}).lean<PetDoc>();
  if (!pet) return notFound("Pet not found.");

  const record = await findRecordArtifact(recordId);
  if (!record || record.petId !== petId) return notFound("Record not found for this pet.");
  if (record.status !== "active") {
    return badRequest("Only an active record can be shared - this record is not yet issued, or has been revoked.");
  }

  if (mask.length > 0) {
    const maskErrors = validateRecordExportMask(mask, record.leaves.map((l) => l.keyPath), record.nonMaskable);
    if (maskErrors.length > 0) {
      return badRequest("One or more fields cannot be masked.", {fieldErrors: {mask: maskErrors}});
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const token = generateHexToken();
  const exp = now + EXPORT_TTL_SECS;

  await ArtifactExportSession.create({
    token,
    petId,
    artifactType: "record",
    recordId,
    root: record.root,
    exp,
    mask: mask.length > 0 ? mask : undefined,
  });

  const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? new URL(request.url).origin;
  const qr = `${baseUrl.replace(/\/$/, "")}/e/${token}`;

  return NextResponse.json({token, qr, ttlSecs: EXPORT_TTL_SECS, issuedAt: now}, {status: 201});
}
