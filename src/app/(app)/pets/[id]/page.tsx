import {notFound} from "next/navigation";
import {PageHeader} from "@/components/shell/PageHeader";
import {connectToDatabase} from "@/lib/db";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {getBookingSettings} from "@/lib/models/Availability";
import {PetForm} from "@/app/(app)/pets/PetForm";
import {PetTagCard} from "@/components/pets/PetTagCard";
import {toPlain} from "@/lib/toPlain";

export default async function PetDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  await connectToDatabase();
  const pet = await Pet.findOne({petId: id}).lean<PetDoc>().then(toPlain);
  if (!pet) notFound();
  const owners = await Client.find({clientId: {$in: pet.ownerClientIds}}).lean<ClientDoc[]>().then(toPlain);
  const {timezone} = await getBookingSettings();

  return (
    <>
      <PageHeader title={pet.name} description="Pet record." />
      <div className="mb-6 max-w-2xl">
        <PetTagCard petId={pet.petId} dogTag={pet.dogTag ?? {}} timeZone={timezone} />
      </div>
      <PetForm pet={pet} initialOwners={owners} />
    </>
  );
}
