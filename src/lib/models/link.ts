import "server-only";
import {Client} from "@/lib/models/Client";
import {Pet} from "@/lib/models/Pet";

/**
 * `Pet.ownerClientIds` and `Client.petIds` are two denormalized views of the same many-to-many
 * relationship (wp4-vet.md's Data model: "ownerClientIds: [clientId] (many-to-many: multiple
 * owners per pet)" alongside `Client.petIds`). Every write to this relationship goes through
 * these two functions so the two sides never drift apart - no call site updates one array
 * directly.
 */
export async function linkPetToClient(petId: string, clientId: string): Promise<void> {
  await Promise.all([
    Pet.updateOne({petId}, {$addToSet: {ownerClientIds: clientId}}),
    Client.updateOne({clientId}, {$addToSet: {petIds: petId}}),
  ]);
}

export async function unlinkPetFromClient(petId: string, clientId: string): Promise<void> {
  await Promise.all([
    Pet.updateOne({petId}, {$pull: {ownerClientIds: clientId}}),
    Client.updateOne({clientId}, {$pull: {petIds: petId}}),
  ]);
}

/** Replaces a pet's full owner set with `clientIds`, keeping both sides of the relationship in
 * sync (added owners get the pet appended to their `petIds`; removed owners get it pulled). */
export async function setPetOwners(petId: string, clientIds: string[]): Promise<void> {
  const pet = await Pet.findOne({petId}).lean<{ownerClientIds: string[]}>();
  const previous = new Set(pet?.ownerClientIds ?? []);
  const next = new Set(clientIds);

  const added = clientIds.filter((id) => !previous.has(id));
  const removed = [...previous].filter((id) => !next.has(id));

  await Promise.all([
    Pet.updateOne({petId}, {$set: {ownerClientIds: clientIds}}),
    ...added.map((clientId) => Client.updateOne({clientId}, {$addToSet: {petIds: petId}})),
    ...removed.map((clientId) => Client.updateOne({clientId}, {$pull: {petIds: petId}})),
  ]);
}
