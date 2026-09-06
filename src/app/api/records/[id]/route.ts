import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {findRecordArtifact} from "@/lib/records/artifact";
import {notFound, requireStaffSession} from "@/lib/staffApi";

/** `GET /api/records/:id` - staff poll of a record's full state, mirroring `api/tags/issue/
 * [sessionId]/route.ts`'s own polling shape (simpler here: a `RecordArtifact` already carries its
 * own `attestation`, unlike a `MintSession`, whose attestation lives on the separately-linked
 * `Pet.dogTag` - there is no second document to also read). */
export async function GET(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id: recordId} = await params;
  await connectToDatabase();
  const record = await findRecordArtifact(recordId);
  if (!record) return notFound("Record not found.");

  return NextResponse.json({record});
}
