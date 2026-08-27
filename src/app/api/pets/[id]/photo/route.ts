import {NextResponse} from "next/server";
import {z} from "zod";
import {connectToDatabase} from "@/lib/db";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {StoredFile} from "@/lib/models/StoredFile";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

const MAX_BYTES = 5 * 1024 * 1024;
const uploadSchema = z.object({
  // Cropped to a square canvas client-side before upload, per wp4-vet.md's "pet photo upload
  // with square crop" - the server trusts the crop rather than re-processing image bytes, so no
  // image-processing dependency is needed in this template.
  dataUrl: z.string().regex(/^data:image\/(png|jpeg|webp);base64,/, "Must be a PNG, JPEG, or WebP data URL"),
});

export async function POST(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  const body = await request.json().catch(() => null);
  const parsed = uploadSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed photo upload.", parsed.error.flatten());

  await connectToDatabase();
  const pet = await Pet.findOne({petId: id}).lean<PetDoc>();
  if (!pet) return notFound("Pet not found.");

  const commaIndex = parsed.data.dataUrl.indexOf(",");
  const header = parsed.data.dataUrl.slice(0, commaIndex);
  const base64 = parsed.data.dataUrl.slice(commaIndex + 1);
  const contentType = header.slice("data:".length, header.indexOf(";"));
  const data = Buffer.from(base64, "base64");
  if (data.byteLength > MAX_BYTES) return badRequest("Photo must be under 5MB.");

  const stored = await StoredFile.create({
    filename: `pet-${id}.${contentType.split("/")[1] ?? "png"}`,
    contentType,
    byteLength: data.byteLength,
    data,
  });
  await Pet.updateOne({petId: id}, {$set: {photoFileId: stored.fileId}});

  return NextResponse.json({photoFileId: stored.fileId});
}
