import {notFound} from "next/navigation";
import {PageHeader} from "@/components/shell/PageHeader";
import {connectToDatabase} from "@/lib/db";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {getBookingSettings} from "@/lib/models/Availability";
import {findActiveTagArtifact} from "@/lib/tags/artifact";
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
  // WP4.10V item 6 - "the pet page shows masked fields as masked by the owner". Pet.dogTag itself
  // carries no leaf-level custody info at all (that lives only on TagArtifact) - a cheap, indexed
  // lookup ({petId, active: true} - TagArtifact.ts's own compound index) rather than denormalizing
  // this count onto Pet, which would need to stay in sync on every artifact write.
  const activeArtifact = await findActiveTagArtifact(pet.petId);
  const maskedFieldCount = activeArtifact?.obfuscatedLeafHashes?.length ?? 0;

  return (
    <>
      <PageHeader title={pet.name} description="Pet record." />
      <div className="mb-6 max-w-2xl">
        <PetTagCard petId={pet.petId} dogTag={pet.dogTag ?? {}} timeZone={timezone} maskedFieldCount={maskedFieldCount} />
      </div>
      <PetForm pet={pet} initialOwners={owners} />
    </>
  );
}
