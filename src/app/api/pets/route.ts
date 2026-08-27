import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Pet, buildPetSearchKey, type PetDoc} from "@/lib/models/Pet";
import {Client} from "@/lib/models/Client";
import {createPetSchema} from "@/lib/schemas/pet";
import {badRequest, requireStaffSession} from "@/lib/staffApi";

/** `GET /api/pets?q=&ownerClientId=` - staff-only pet list. */
export async function GET(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  await connectToDatabase();
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim().toLowerCase();
  const ownerClientId = url.searchParams.get("ownerClientId") ?? undefined;

  const filter: Record<string, unknown> = {};
  if (q) filter.searchKey = {$regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};
  if (ownerClientId) filter.ownerClientIds = ownerClientId;

  const pets = await Pet.find(filter).sort({name: 1}).limit(200).lean<PetDoc[]>();
  return NextResponse.json(pets);
}

export async function POST(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = createPetSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed pet payload.", parsed.error.flatten());

  await connectToDatabase();
  const created = await Pet.create({
    ...parsed.data,
    dogTag: {},
    searchKey: buildPetSearchKey(parsed.data),
  });
  // Pet.ownerClientIds is set directly above; the other denormalized side (Client.petIds) still
  // needs the reverse link - see src/lib/models/link.ts's doc comment on why both sides always
  // update together.
  await Promise.all(
    parsed.data.ownerClientIds.map((clientId) => Client.updateOne({clientId}, {$addToSet: {petIds: created.petId}})),
  );
  return NextResponse.json(created.toObject(), {status: 201});
}
