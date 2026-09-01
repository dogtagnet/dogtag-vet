import {notFound} from "next/navigation";
import {PageHeader} from "@/components/shell/PageHeader";
import {DataTable} from "@/components/ui/DataTable";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {KeyValuePanel} from "@/components/ui/KeyValuePanel";
import {HashCell} from "@/components/ui/HashCell";
import {PaymentRailTabs} from "@/components/payments/PaymentRailTabs";
import {formatUnixSeconds} from "@/lib/format";
import {paymentStatusLabel, paymentStatusTone} from "@/lib/paymentTone";
import {connectToDatabase} from "@/lib/db";
import {getBookingSettings} from "@/lib/models/Availability";
import {Payment, type PaymentDoc, type LineItem} from "@/lib/models/Payment";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {getServerEnv} from "@/lib/env";
import {PaymentActions} from "@/app/(app)/payments/[id]/PaymentActions";
import {toPlain} from "@/lib/toPlain";

export default async function PaymentDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  await connectToDatabase();
  const payment = await Payment.findOne({paymentId: id}).lean<PaymentDoc>().then(toPlain);
  if (!payment) notFound();

  const [client, pet, bookingSettings] = await Promise.all([
    payment.clientId ? Client.findOne({clientId: payment.clientId}).lean<ClientDoc>().then(toPlain) : Promise.resolve(null),
    payment.petId ? Pet.findOne({petId: payment.petId}).lean<PetDoc>().then(toPlain) : Promise.resolve(null),
    getBookingSettings(),
  ]);
  const timeZone = bookingSettings.timezone;

  const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? "";
  const viewUrl = `${baseUrl.replace(/\/$/, "")}/pay/${payment.paymentId}?token=${payment.viewToken}`;

  return (
    <>
      <PageHeader
        title={`Invoice ${payment.invoiceNumber}`}
        description={`${payment.total} ${payment.currency}`}
        action={<StatusBadge tone={paymentStatusTone[payment.status]} label={paymentStatusLabel[payment.status]} />}
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <DataTable
            columns={[
              {key: "description", header: "Description", render: (li: LineItem) => li.description},
              {key: "qty", header: "Qty", align: "right", render: (li: LineItem) => String(li.qty)},
              {key: "unit", header: "Unit", align: "right", mono: true, render: (li: LineItem) => li.unitAmount},
              {key: "amount", header: "Amount", align: "right", mono: true, render: (li: LineItem) => li.amount},
            ]}
            rows={payment.lineItems}
            getRowKey={(li) => li.description}
          />

          <KeyValuePanel
            title="Totals"
            rows={[
              {key: "subtotal", label: "Subtotal", value: `${payment.subtotal} ${payment.currency}`},
              ...(payment.tax
                ? [{key: "tax", label: `${payment.tax.label} (${payment.tax.rate})`, value: `${payment.tax.amount} ${payment.currency}`}]
                : []),
              {key: "total", label: "Total", value: `${payment.total} ${payment.currency}`},
              ...(payment.dueAt ? [{key: "due", label: "Due", value: formatUnixSeconds(payment.dueAt, timeZone)}] : []),
            ]}
          />

          {payment.paidWith && (
            <KeyValuePanel
              title="Paid with"
              rows={[
                {key: "chain", label: "Chain", value: payment.paidWith.chainKey},
                {key: "token", label: "Token", value: payment.paidWith.token},
                {key: "tx", label: "Transaction", value: <HashCell value={payment.paidWith.txHash} chain={payment.paidWith.chainKey} kind="tx" />},
                {key: "from", label: "From", value: <HashCell value={payment.paidWith.from} kind="doc" />},
              ]}
            />
          )}
          {payment.manualPaidNote && (
            <KeyValuePanel title="Paid manually" rows={[{key: "note", label: "Note", value: payment.manualPaidNote}]} />
          )}

          {payment.crypto.length > 0 && <PaymentRailTabs rails={payment.crypto} dueAt={payment.dueAt} />}
        </div>

        <div className="space-y-6">
          {(client || pet) && (
            <KeyValuePanel
              title="Linked to"
              rows={[
                ...(client ? [{key: "client", label: "Client", value: client.name}] : []),
                ...(pet ? [{key: "pet", label: "Pet", value: pet.name}] : []),
              ]}
            />
          )}
          <PaymentActions paymentId={payment.paymentId} status={payment.status} viewUrl={viewUrl} />
          {payment.emailedTo.length > 0 && (
            <KeyValuePanel
              title="Emailed to"
              rows={payment.emailedTo.map((e, i) => ({
                key: `${e.email}-${i}`,
                label: formatUnixSeconds(Math.floor(new Date(e.at).getTime() / 1000), timeZone),
                value: e.email,
              }))}
            />
          )}
        </div>
      </div>
    </>
  );
}
