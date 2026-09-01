import {notFound} from "next/navigation";
import {PageHeader} from "@/components/shell/PageHeader";
import {connectToDatabase} from "@/lib/db";
import {Service, type ServiceDoc} from "@/lib/models/Service";
import {ServiceForm} from "@/app/(app)/services/ServiceForm";
import {toPlain} from "@/lib/toPlain";

export default async function ServiceDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  await connectToDatabase();
  const service = await Service.findOne({serviceId: id}).lean<ServiceDoc>().then(toPlain);
  if (!service) notFound();

  return (
    <>
      <PageHeader title={service.name} description="Service details." />
      <ServiceForm service={service} />
    </>
  );
}
