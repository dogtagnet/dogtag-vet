import {PageHeader} from "@/components/shell/PageHeader";
import {Button} from "@/components/ui/controls";
import {DataTable} from "@/components/ui/DataTable";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {connectToDatabase} from "@/lib/db";
import {Payment, type PaymentDoc} from "@/lib/models/Payment";
import {aggregateMonthlyTotals, type MonthlyTotal} from "@/lib/payments/accounting";
import {paymentStatusLabel, paymentStatusTone} from "@/lib/paymentTone";

export default async function AccountingPage() {
  await connectToDatabase();
  const payments = await Payment.find({}).select("createdAt status currency total").lean<PaymentDoc[]>();
  const rows = aggregateMonthlyTotals(payments);

  return (
    <>
      <PageHeader
        title="Accounting"
        description="Monthly totals by status and currency."
        action={
          <a href="/api/payments/accounting/export">
            <Button variant="secondary">Export CSV</Button>
          </a>
        }
      />
      <DataTable
        columns={[
          {key: "month", header: "Month", mono: true, render: (r: MonthlyTotal) => r.month},
          {
            key: "status",
            header: "Status",
            render: (r: MonthlyTotal) => <StatusBadge tone={paymentStatusTone[r.status]} label={paymentStatusLabel[r.status]} />,
          },
          {key: "currency", header: "Currency", render: (r: MonthlyTotal) => r.currency},
          {key: "total", header: "Total", align: "right", mono: true, render: (r: MonthlyTotal) => r.total},
        ]}
        rows={rows}
        getRowKey={(r) => `${r.month}:${r.status}:${r.currency}`}
        emptyMessage="No payments recorded yet."
      />
    </>
  );
}
