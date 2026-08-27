import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Client, buildClientSearchKey, type ClientDoc} from "@/lib/models/Client";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {updateClientSchema} from "@/lib/schemas/client";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

export async function GET(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  await connectToDatabase();
  const client = await Client.findOne({clientId: id}).lean<ClientDoc>();
  if (!client) return notFound("Client not found.");
  const pets = await Pet.find({petId: {$in: client.petIds}}).lean<PetDoc[]>();
  return NextResponse.json({...client, pets});
}

export async function PATCH(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  const body = await request.json().catch(() => null);
  const parsed = updateClientSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed client payload.", parsed.error.flatten());

  await connectToDatabase();
  const existing = await Client.findOne({clientId: id}).lean<ClientDoc>();
  if (!existing) return notFound("Client not found.");

  const merged = {...existing, ...parsed.data};
  const updated = await Client.findOneAndUpdate(
    {clientId: id},
    {$set: {...parsed.data, searchKey: buildClientSearchKey(merged)}},
    {new: true},
  ).lean<ClientDoc>();
  return NextResponse.json(updated);
}
