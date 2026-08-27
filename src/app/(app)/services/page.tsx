import Link from "next/link";
import {PageHeader} from "@/components/shell/PageHeader";
import {Button} from "@/components/ui/controls";
import {DataTable} from "@/components/ui/DataTable";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {connectToDatabase} from "@/lib/db";
import {Service, type ServiceDoc} from "@/lib/models/Service";

export default async function ServicesPage() {
  await connectToDatabase();
  const services = await Service.find({}).sort({name: 1}).lean<ServiceDoc[]>();

  return (
    <>
      <PageHeader
        title="Services"
        description="What clients can book, in staff and public flows."
        action={
          <Link href="/services/new">
            <Button>New service</Button>
          </Link>
        }
      />
      <DataTable
        columns={[
          {
            key: "name",
            header: "Name",
            render: (s: ServiceDoc) => (
              <Link href={`/services/${s.serviceId}`} className="font-medium text-link hover:underline">
                {s.name}
              </Link>
            ),
          },
          {key: "duration", header: "Duration", render: (s: ServiceDoc) => `${s.durationMinutes} min`},
          {
            key: "price",
            header: "Price",
            align: "right",
            mono: true,
            render: (s: ServiceDoc) => (s.price ? `${s.price.amount} ${s.price.currency}` : "-"),
          },
          {
            key: "status",
            header: "Status",
            render: (s: ServiceDoc) => <StatusBadge tone={s.active ? "ok" : "neutral"} label={s.active ? "Active" : "Inactive"} />,
          },
          {
            key: "online",
            header: "Online booking",
            render: (s: ServiceDoc) =>
              s.bookableOnline ? <StatusBadge tone="info" label="Enabled" /> : <StatusBadge tone="neutral" label="Staff only" />,
          },
        ]}
        rows={services}
        getRowKey={(s) => s.serviceId}
        emptyMessage="No services yet."
      />
    </>
  );
}
