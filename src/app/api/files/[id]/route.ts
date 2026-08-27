import {connectToDatabase} from "@/lib/db";
import {StoredFile, type StoredFileDoc} from "@/lib/models/StoredFile";
import {requireStaffSession} from "@/lib/staffApi";

/** Serves a stored file (pet photos, generated PDFs) by id. Staff-only for now - pet photos are
 * only ever rendered inside the staff CRM in this stage. */
export async function GET(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  await connectToDatabase();
  const file = await StoredFile.findOne({fileId: id}).lean<StoredFileDoc>();
  if (!file) return new Response("Not found", {status: 404});

  return new Response(new Uint8Array(file.data.buffer, file.data.byteOffset, file.data.byteLength), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.byteLength),
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
