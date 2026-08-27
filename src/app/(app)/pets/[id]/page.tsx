import {notFound} from "next/navigation";
import {PageHeader} from "@/components/shell/PageHeader";
import {connectToDatabase} from "@/lib/db";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {PetForm} from "@/app/(app)/pets/PetForm";

export default async function PetDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  await connectToDatabase();
  const pet = await Pet.findOne({petId: id}).lean<PetDoc>();
  if (!pet) notFound();
  const owners = await Client.find({clientId: {$in: pet.ownerClientIds}}).lean<ClientDoc[]>();

  return (
    <>
      <PageHeader title={pet.name} description="Pet record." />
      <PetForm pet={pet} initialOwners={owners} />
    </>
  );
}
