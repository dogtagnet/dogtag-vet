import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {Pet, buildPetSearchKey, type PetDoc} from "@/lib/models/Pet";
import {setPetOwners} from "@/lib/models/link";
import {updatePetSchema} from "@/lib/schemas/pet";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

export async function GET(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  await connectToDatabase();
  const pet = await Pet.findOne({petId: id}).lean<PetDoc>();
  if (!pet) return notFound("Pet not found.");
  const owners = await Client.find({clientId: {$in: pet.ownerClientIds}}).lean<ClientDoc[]>();
  return NextResponse.json({...pet, owners});
}

export async function PATCH(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  const body = await request.json().catch(() => null);
  const parsed = updatePetSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed pet payload.", parsed.error.flatten());

  await connectToDatabase();
  const existing = await Pet.findOne({petId: id}).lean<PetDoc>();
  if (!existing) return notFound("Pet not found.");

  const {ownerClientIds, ...rest} = parsed.data;
  const merged = {...existing, ...rest};
  const updated = await Pet.findOneAndUpdate(
    {petId: id},
    {$set: {...rest, searchKey: buildPetSearchKey(merged)}},
    {new: true},
  ).lean<PetDoc>();

  if (ownerClientIds) {
    await setPetOwners(id, ownerClientIds);
  }

  const final = ownerClientIds ? await Pet.findOne({petId: id}).lean<PetDoc>() : updated;
  return NextResponse.json(final);
}
