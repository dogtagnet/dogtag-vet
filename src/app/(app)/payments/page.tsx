import Link from "next/link";
import {PageHeader} from "@/components/shell/PageHeader";
import {Button} from "@/components/ui/controls";
import {DataTable} from "@/components/ui/DataTable";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {formatUnixSeconds} from "@/lib/format";
import {paymentStatusLabel, paymentStatusTone} from "@/lib/paymentTone";
import {connectToDatabase} from "@/lib/db";
import {Payment, type PaymentDoc} from "@/lib/models/Payment";
import {addAmounts} from "@/lib/payments/money";
import {PaymentFilters} from "@/app/(app)/payments/PaymentFilters";

interface PaymentsSearchParams {
  status?: string;
}

export default async function PaymentsPage({searchParams}: {searchParams: Promise<PaymentsSearchParams>}) {
  const {status} = await searchParams;
  await connectToDatabase();

  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;

  const payments = await Payment.find(filter).sort({createdAt: -1}).limit(500).lean<PaymentDoc[]>();

  // Totals by (status, currency) for the currently filtered set - a compact strip, not a full
  // accounting breakdown (that lives at /accounting).
  const totals = new Map<string, string>();
  for (const p of payments) {
    const key = `${p.status}:${p.currency}`;
    totals.set(key, addAmounts(totals.get(key) ?? "0", p.total));
  }

  return (
    <>
      <PageHeader
        title="Payments"
        description="Invoices, crypto rails, and receipts."
        action={
          <Link href="/payments/new">
            <Button>New payment</Button>
          </Link>
        }
      />
      <PaymentFilters />
      {totals.size > 0 && (
        <p className="mb-4 text-body text-ink-muted">
          {Array.from(totals.entries())
            .map(([key, total]) => {
              const [s, currency] = key.split(":");
              return `${paymentStatusLabel[s as PaymentDoc["status"]]}: ${total} ${currency}`;
            })
            .join(" · ")}
        </p>
      )}
      <DataTable
        columns={[
          {
            key: "invoice",
            header: "Invoice",
            render: (p: PaymentDoc) => (
              <Link href={`/payments/${p.paymentId}`} className="font-medium text-link hover:underline">
                {p.invoiceNumber}
              </Link>
            ),
          },
          {
            key: "total",
            header: "Total",
            align: "right",
            mono: true,
            render: (p: PaymentDoc) => `${p.total} ${p.currency}`,
          },
          {
            key: "status",
            header: "Status",
            render: (p: PaymentDoc) => <StatusBadge tone={paymentStatusTone[p.status]} label={paymentStatusLabel[p.status]} />,
          },
          {
            key: "due",
            header: "Due",
            render: (p: PaymentDoc) => (p.dueAt ? formatUnixSeconds(p.dueAt) : "-"),
          },
          {
            key: "created",
            header: "Created",
            render: (p: PaymentDoc) => formatUnixSeconds(Math.floor(new Date(p.createdAt).getTime() / 1000)),
          },
        ]}
        rows={payments}
        getRowKey={(p) => p.paymentId}
        emptyMessage="No payments match these filters."
      />
    </>
  );
}
