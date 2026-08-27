import {PageHeader} from "@/components/shell/PageHeader";
import {PaymentForm} from "@/app/(app)/payments/PaymentForm";

export default function NewPaymentPage() {
  return (
    <>
      <PageHeader title="New payment" description="Create an invoice with fiat line items and optional crypto rails." />
      <PaymentForm />
    </>
  );
}
