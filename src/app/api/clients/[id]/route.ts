import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Client, buildClientSearchKey, splitSetUnsetOps, type ClientDoc} from "@/lib/models/Client";
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
  // `wallets` has a schema-level `default: []`, but Mongoose defaults only fire at document
  // CREATION time - a Client document that predates this field (any client created before this
  // migration) reads back with `wallets` entirely absent, not `[]` (same class of gap
  // `toSessionRow`'s microchip/ownerIdentity fallback fixes for MintSession). Defended here so a
  // consumer of this route can always treat `wallets` as an array.
  return NextResponse.json({...client, pets, wallets: client.wallets ?? []});
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

  // Round-2 fix: parsed.data can carry `null` for idDocType/idDocNumber (an explicit clear, per
  // updateClientSchema's doc comment) - `splitSetUnsetOps` routes those into an `$unset` instead of
  // letting them ride into `$set` as a literal `null` value (which `JSON.stringify` on the CLIENT
  // side would have dropped anyway, but a direct API caller sending `null` deserves the same
  // behavior the UI now relies on).
  const {setOps, unsetOps} = splitSetUnsetOps(parsed.data);
  const merged: Record<string, unknown> = {...existing, ...setOps};
  for (const key of Object.keys(unsetOps)) delete merged[key];
  // Read the three searchKey fields back out explicitly rather than asserting the whole `merged`
  // blob is a ClientDoc: `splitSetUnsetOps` is deliberately field-agnostic (its own tests exercise
  // `email`/`name` going through $unset too), so nothing actually guarantees these three stayed
  // strings if a future schema change made one of them nullable - `name` falls back to `existing`
  // since buildClientSearchKey requires it non-optional, exactly as it always has been (`name` is
  // not nullable in updateClientSchema, so this fallback is unreachable today, but it keeps the type
  // honest without relying on that staying true).
  const searchKeyFields = {
    name: (merged.name as string | undefined) ?? existing.name,
    email: merged.email as string | undefined,
    phone: merged.phone as string | undefined,
  };

  const update: Record<string, unknown> = {$set: {...setOps, searchKey: buildClientSearchKey(searchKeyFields)}};
  if (Object.keys(unsetOps).length > 0) update.$unset = unsetOps;

  const updated = await Client.findOneAndUpdate({clientId: id}, update, {new: true}).lean<ClientDoc>();
  return NextResponse.json(updated);
}
