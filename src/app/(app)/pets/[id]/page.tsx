import {notFound} from "next/navigation";
import {PageHeader} from "@/components/shell/PageHeader";
import {connectToDatabase} from "@/lib/db";
import {auth} from "@/auth";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {Staff, type StaffDoc} from "@/lib/models/Staff";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {getBookingSettings} from "@/lib/models/Availability";
import {findActiveTagArtifact} from "@/lib/tags/artifact";
import {resolveOperatorStatus} from "@/lib/issuanceOperatorStatus";
import {isVetOrOwner} from "@/lib/staffRoleTone";
import {loadOwnersCardData} from "@/lib/delegation/ownersCardData";
import {PetForm} from "@/app/(app)/pets/PetForm";
import {PetTagCard} from "@/components/pets/PetTagCard";
import {OwnersCard} from "@/components/pets/OwnersCard";
import {VetWalletStatusBanner} from "@/app/(app)/tags/VetWalletStatusBanner";
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

  // WP4.15 multi-owner (PLANNED) - the Owners card, gated on the SAME vet/owner + K2 whitelist
  // signal every other issuance surface shares (`/tags`, `/tags/issue`), never a second,
  // independently-derived check.
  const session = await auth();
  const canManage = isVetOrOwner(session?.user?.role);
  const [settings, staffRow, ownersCardData] = await Promise.all([
    getClinicSettings(),
    canManage ? Staff.findOne({staffId: session?.user?.staffId}).lean<StaffDoc>() : Promise.resolve(null),
    loadOwnersCardData(pet.petId, pet.dogTag?.dogTagIdField, pet.primaryOwnerClientId),
  ]);
  const operatorStatus = canManage ? await resolveOperatorStatus({walletAddress: staffRow?.walletAddress, cloneAddress: settings.cloneAddress}) : null;
  const primaryOwnerLabel = ownersCardData.primaryOwnerName ?? (ownersCardData.primaryOwnerClientId ? "Unknown client" : undefined);

  return (
    <>
      <PageHeader title={pet.name} description="Pet record." />
      {canManage && operatorStatus && pet.dogTag?.dogTagIdField && (
        <VetWalletStatusBanner status={operatorStatus.status} recordedAddress={operatorStatus.recordedAddress} />
      )}
      <div className="mb-6 max-w-2xl space-y-6">
        <PetTagCard petId={pet.petId} dogTag={pet.dogTag ?? {}} timeZone={timezone} maskedFieldCount={maskedFieldCount} />
        <OwnersCard
          petId={pet.petId}
          dogTagIdField={pet.dogTag?.dogTagIdField}
          primaryOwnerLabel={primaryOwnerLabel}
          data={ownersCardData}
          canManage={canManage}
          timeZone={timezone}
        />
      </div>
      <PetForm pet={pet} initialOwners={owners} />
    </>
  );
}
