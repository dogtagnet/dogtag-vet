import Link from "next/link";
import {PageHeader} from "@/components/shell/PageHeader";
import {Button} from "@/components/ui/controls";
import {DataTable} from "@/components/ui/DataTable";
import {SearchBox} from "@/components/ui/SearchBox";
import {connectToDatabase} from "@/lib/db";
import {Client, type ClientDoc} from "@/lib/models/Client";

export default async function ClientsPage({searchParams}: {searchParams: Promise<{q?: string}>}) {
  const {q} = await searchParams;
  await connectToDatabase();
  const filter = q ? {searchKey: {$regex: q.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}} : {};
  const clients = await Client.find(filter).sort({name: 1}).limit(200).lean<ClientDoc[]>();

  return (
    <>
      <PageHeader
        title="Clients"
        description="Pet owners and their contact details."
        action={
          <Link href="/clients/new">
            <Button>New client</Button>
          </Link>
        }
      />
      <div className="mb-4">
        <SearchBox placeholder="Search clients by name, email, or phone" />
      </div>
      <DataTable
        columns={[
          {
            key: "name",
            header: "Name",
            render: (c: ClientDoc) => (
              <Link href={`/clients/${c.clientId}`} className="font-medium text-link hover:underline">
                {c.name}
              </Link>
            ),
          },
          {key: "email", header: "Email", render: (c: ClientDoc) => c.email ?? "-"},
          {key: "phone", header: "Phone", render: (c: ClientDoc) => c.phone ?? "-"},
          {key: "pets", header: "Pets", align: "right", render: (c: ClientDoc) => c.petIds.length},
        ]}
        rows={clients}
        getRowKey={(c) => c.clientId}
        emptyMessage={q ? "No clients match that search." : "No clients yet."}
      />
    </>
  );
}
