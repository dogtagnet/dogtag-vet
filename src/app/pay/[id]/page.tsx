import {notFound} from "next/navigation";
import {connectToDatabase} from "@/lib/db";
import {Payment, type PaymentDoc} from "@/lib/models/Payment";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {getBookingSettings} from "@/lib/models/Availability";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {HashCell} from "@/components/ui/HashCell";
import {PaymentRailTabs} from "@/components/payments/PaymentRailTabs";
import {paymentStatusLabel, paymentStatusTone} from "@/lib/paymentTone";
import {formatUnixSeconds} from "@/lib/format";
import {LivePaymentStatus} from "@/app/pay/[id]/LivePaymentStatus";

/**
 * The public payment/receipt page: `/pay/{id}?token=...`, where `token` is `Payment.viewToken`
 * (stamped on the invoice's shareable link, distinct from the wire-spec `receiptToken`). This is
 * the "receipt page ... shows status and offers PDF download (works pre- and post-payment)" from
 * wp4-vet.md's payments section - deliberately NOT the same route as the wire-authoritative
 * `GET /r/pay/{receiptToken}` (which only ever serves the paid-only PDF per
 * `vet-public-api.yaml`; see that route's own doc comment for the full reconciliation). Pre-paid,
 * the "download invoice" link goes through the sibling `/pay/{id}/invoice` route (unstamped,
 * token-gated - see that route's own doc comment for why it lives under this same public prefix);
 * post-paid, a second link offers the official stamped receipt at the wire-spec path.
 */
export default async function PublicPaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{id: string}>;
  searchParams: Promise<{token?: string}>;
}) {
  const {id} = await params;
  const {token} = await searchParams;

  await connectToDatabase();
  const payment = await Payment.findOne({paymentId: id}).lean<PaymentDoc>();
  if (!payment || !token || payment.viewToken !== token) notFound();

  const [settings, bookingSettings] = await Promise.all([getClinicSettings(), getBookingSettings()]);
  const paid = payment.status === "paid";

  return (
    <main className="mx-auto max-w-xl space-y-6 p-6">
      <LivePaymentStatus paymentId={payment.paymentId} token={token} initialStatus={payment.status} />

      <header className="space-y-1">
        <p className="text-caption uppercase tracking-wide text-ink-faint">{settings.businessProfile.name ?? "Invoice"}</p>
        <h1 className="text-page-title text-ink">Invoice {payment.invoiceNumber}</h1>
        <StatusBadge tone={paymentStatusTone[payment.status]} label={paymentStatusLabel[payment.status]} />
      </header>

      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <p className="text-hero text-ink">
          {payment.total} <span className="text-body text-ink-muted">{payment.currency}</span>
        </p>
        {payment.dueAt && !paid && (
          <p className="mt-1 text-body text-ink-muted">Due {formatUnixSeconds(payment.dueAt, bookingSettings.timezone, true)}</p>
        )}
      </div>

      {paid && (
        <div className="rounded-card border border-ok/30 bg-ok-soft p-5">
          <p className="text-emphasized font-semibold text-ok">Paid</p>
          {payment.paidWith && (
            <div className="mt-2 text-body text-ink">
              <HashCell value={payment.paidWith.txHash} chain={payment.paidWith.chainKey} kind="tx" label="Transaction" />
            </div>
          )}
        </div>
      )}

      {!paid && payment.crypto.length > 0 && <PaymentRailTabs rails={payment.crypto} dueAt={payment.dueAt} />}

      <div className="flex flex-wrap gap-3">
        <a href={`/pay/${payment.paymentId}/invoice?token=${encodeURIComponent(token)}`} target="_blank" rel="noreferrer" className="text-link hover:underline">
          Download invoice PDF
        </a>
        {paid && (
          <a href={`/r/pay/${payment.receiptToken}`} target="_blank" rel="noreferrer" className="text-link hover:underline">
            Download receipt PDF
          </a>
        )}
      </div>
    </main>
  );
}
