import Link from "next/link";
import {notFound} from "next/navigation";
import {PageHeader} from "@/components/shell/PageHeader";
import {FormSection} from "@/components/ui/FormSection";
import {connectToDatabase} from "@/lib/db";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {ClientForm} from "@/app/(app)/clients/ClientForm";

export default async function ClientDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  await connectToDatabase();
  const client = await Client.findOne({clientId: id}).lean<ClientDoc>();
  if (!client) notFound();
  const pets = await Pet.find({petId: {$in: client.petIds}}).lean<PetDoc[]>();

  return (
    <>
      <PageHeader title={client.name} description="Client details." />
      <div className="max-w-2xl space-y-6">
        <ClientForm client={client} />
        <FormSection title="Pets" helperText="Pets owned by this client.">
          {pets.length === 0 ? (
            <p className="text-body text-ink-faint">No pets linked yet.</p>
          ) : (
            <ul className="space-y-2">
              {pets.map((pet) => (
                <li key={pet.petId}>
                  <Link href={`/pets/${pet.petId}`} className="text-body font-medium text-link hover:underline">
                    {pet.name}
                  </Link>
                  {pet.species && <span className="ml-2 text-body text-ink-muted">{pet.species}</span>}
                </li>
              ))}
            </ul>
          )}
          <Link href={`/pets/new?ownerClientId=${client.clientId}`} className="text-body text-link hover:underline">
            + Add a pet for this client
          </Link>
        </FormSection>
      </div>
    </>
  );
}
