import {PageHeader} from "@/components/shell/PageHeader";
import {connectToDatabase} from "@/lib/db";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {PetForm} from "@/app/(app)/pets/PetForm";

export default async function NewPetPage({searchParams}: {searchParams: Promise<{ownerClientId?: string}>}) {
  const {ownerClientId} = await searchParams;
  let defaultOwner: {clientId: string; name: string} | undefined;
  if (ownerClientId) {
    await connectToDatabase();
    const client = await Client.findOne({clientId: ownerClientId}).lean<ClientDoc>();
    if (client) defaultOwner = {clientId: client.clientId, name: client.name};
  }

  return (
    <>
      <PageHeader title="New pet" />
      <PetForm defaultOwnerClientId={defaultOwner} />
    </>
  );
}
