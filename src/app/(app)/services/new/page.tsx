import {PageHeader} from "@/components/shell/PageHeader";
import {ServiceForm} from "@/app/(app)/services/ServiceForm";

export default function NewServicePage() {
  return (
    <>
      <PageHeader title="New service" />
      <ServiceForm />
    </>
  );
}
