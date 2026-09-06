import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {findRecordArtifact} from "@/lib/records/artifact";
import {listExportableRecordFields} from "@/lib/records/exportFlow";
import {notFound, requireStaffSession} from "@/lib/staffApi";

/**
 * `GET /api/pets/:id/records/:recordId/export/fields` - plan section 11.2 V5's field-picker data
 * source, the record sibling of `api/pets/[id]/export-tag-data/fields/route.ts`. Staff-only,
 * read-only. Every leaf carries its precomputed `leafHash` (hashing happens here, server-side, for
 * the identical cold-client-build reason the tag route's own doc comment names) and whether it is
 * `locked` (one of the seven non-maskable keyPaths - the plan's own "locked in the export UI" half
 * of its non-negotiable).
 */
export async function GET(_request: Request, {params}: {params: Promise<{id: string; recordId: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id: petId, recordId} = await params;
  await connectToDatabase();
  const record = await findRecordArtifact(recordId);
  if (!record || record.petId !== petId) return notFound("Record not found for this pet.");

  return NextResponse.json({fields: listExportableRecordFields(record.leaves)});
}
