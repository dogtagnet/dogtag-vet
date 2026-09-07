import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {findRecordArtifact} from "@/lib/records/artifact";
import {buildRecordExportPayload} from "@/lib/records/exportFlow";
import {validateRecordExportMask} from "@/lib/records/exportMask";
import {recordExportMaskRequestSchema} from "@/lib/schemas/recordExport";
import {roax} from "@/lib/chains";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

/**
 * `POST /api/pets/:id/records/:recordId/export/preview` - plan section 11.2 V5's "Download JSON"/
 * "Copy JSON" actions, the record sibling of `api/pets/[id]/export-tag-data/preview/route.ts`.
 * Staff-only, produces the EXACT `RecordArtifact`-shaped payload a masked `GET /e/{token}` fetch
 * would eventually return, without minting or consuming any one-time session - staff already has
 * standing access to this record's own already-issued data. Same CORS/token-burning rationale as
 * the tag preview route for why this is not simply "mint a session, then fetch its /e/:token URL".
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

  if (mask.length > 0) {
    const maskErrors = validateRecordExportMask(mask, record.leaves.map((l) => l.keyPath), record.nonMaskable);
    if (maskErrors.length > 0) {
      return badRequest("One or more fields cannot be masked.", {fieldErrors: {mask: maskErrors}});
    }
  }

  const built = buildRecordExportPayload({...record, obfuscatedLeafHashes: record.obfuscatedLeafHashes ?? []}, mask);
  if (!built.ok) {
    console.error(`record export preview self-check failed for recordId=${recordId} root=${record.root} (mask=${JSON.stringify(mask)}).`);
    return NextResponse.json(
      {error: {code: "internal_error", message: "Something went wrong preparing this record's data."}},
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
