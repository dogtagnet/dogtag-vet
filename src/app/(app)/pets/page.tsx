import Link from "next/link";
import {PageHeader} from "@/components/shell/PageHeader";
import {Button} from "@/components/ui/controls";
import {DataTable} from "@/components/ui/DataTable";
import {SearchBox} from "@/components/ui/SearchBox";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {connectToDatabase} from "@/lib/db";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {dogTagStatusLabel, dogTagStatusTone} from "@/lib/tagStatusTone";

export default async function PetsPage({searchParams}: {searchParams: Promise<{q?: string}>}) {
  const {q} = await searchParams;
  await connectToDatabase();
  const filter = q ? {searchKey: {$regex: q.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}} : {};
  const pets = await Pet.find(filter).sort({name: 1}).limit(200).lean<PetDoc[]>();

  return (
    <>
      <PageHeader
        title="Pets"
        description="Patient records."
        action={
          <Link href="/pets/new">
            <Button>New pet</Button>
          </Link>
        }
      />
      <div className="mb-4">
        <SearchBox placeholder="Search pets by name, species, or breed" />
      </div>
      <DataTable
        columns={[
          {
            key: "name",
            header: "Name",
            render: (p: PetDoc) => (
              <Link href={`/pets/${p.petId}`} className="font-medium text-link hover:underline">
                {p.name}
              </Link>
            ),
          },
          {key: "species", header: "Species", render: (p: PetDoc) => p.species ?? "-"},
          {key: "breed", header: "Breed", render: (p: PetDoc) => p.breed ?? "-"},
          {
            key: "dogTag",
            header: "DogTag",
            render: (p: PetDoc) => {
              const status = p.dogTag?.status;
              return status ? (
                <StatusBadge tone={dogTagStatusTone[status]} label={dogTagStatusLabel[status]} />
              ) : (
                <StatusBadge tone="neutral" label="None" />
              );
            },
          },
        ]}
        rows={pets}
        getRowKey={(p) => p.petId}
        emptyMessage={q ? "No pets match that search." : "No pets yet."}
      />
    </>
  );
}
