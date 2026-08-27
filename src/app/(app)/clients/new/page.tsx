import {PageHeader} from "@/components/shell/PageHeader";
import {ClientForm} from "@/app/(app)/clients/ClientForm";

export default function NewClientPage() {
  return (
    <>
      <PageHeader title="New client" />
      <ClientForm />
    </>
  );
}
