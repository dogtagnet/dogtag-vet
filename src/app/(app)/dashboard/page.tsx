import Link from "next/link";
import type {ReactNode} from "react";
import {PageHeader} from "@/components/shell/PageHeader";
import {Banner} from "@/components/ui/Banner";
import {DataTable} from "@/components/ui/DataTable";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {Timeline, type TimelineEntry} from "@/components/ui/Timeline";
import {formatUnixSeconds} from "@/lib/format";
import {appointmentStatusLabel, appointmentStatusTone} from "@/lib/appointmentTone";
import {calendarRangeFor} from "@/lib/booking/calendarRange";
import {todayInTimeZone} from "@/lib/booking/dst";
import {addAmounts} from "@/lib/payments/money";
import {connectToDatabase} from "@/lib/db";
import {getBookingSettings} from "@/lib/models/Availability";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {Client} from "@/lib/models/Client";
import {Pet} from "@/lib/models/Pet";
import {Appointment, type AppointmentDoc} from "@/lib/models/Appointment";
import {Payment, type PaymentDoc} from "@/lib/models/Payment";
import {ChainActivity, type ChainActivityDoc} from "@/lib/models/ChainActivity";
import {reasonCodeLabel} from "@/lib/reasonCodes";

function StatTile({label, value, hint, href}: {label: string; value: string; hint?: string; href?: string}) {
  const content = (
    <div className="h-full rounded-card border border-border bg-surface p-5 shadow-card transition-colors hover:bg-surface-2">
      <p className="text-caption uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="mt-1 text-hero text-ink">{value}</p>
      {hint && <p className="mt-1 text-caption text-ink-faint">{hint}</p>}
    </div>
  );
  return href ? <Link href={href}>{content}</Link> : content;
}

/**
 * `/dashboard` - the post-login landing page. design-system.md's first principle is "Data first:
 * tables, key-value panels, and timelines are the primary surfaces", so once setup is complete
 * (the steady state for every real clinic) this renders the clinic's actual state rather than a
 * page that only ever shows a banner: headline counts, today's schedule, and recent on-chain
 * activity - the same primitives every other page in this app already uses (`DataTable`,
 * `Timeline`), not a bespoke widget set.
 */
export default async function DashboardPage({searchParams}: {searchParams: Promise<{notice?: string}>}) {
  const {notice} = await searchParams;
  let cloneConfigured = false;
  let content: ReactNode = null;

  try {
    await connectToDatabase();
    const [settings, bookingSettings] = await Promise.all([getClinicSettings(), getBookingSettings()]);
    cloneConfigured = Boolean(settings.cloneAddress);
    const timeZone = bookingSettings.timezone;
    const {fromUtc, toUtc} = calendarRangeFor(todayInTimeZone(timeZone), 1, timeZone);

    const [clientCount, petCount, activeTagCount, todaysAppointments, pendingPayments, recentActivity] = await Promise.all([
      Client.countDocuments(),
      Pet.countDocuments(),
      Pet.countDocuments({"dogTag.status": "active"}),
      Appointment.find({startAt: {$gte: fromUtc, $lt: toUtc}, status: {$ne: "cancelled"}})
        .sort({startAt: 1})
        .lean<AppointmentDoc[]>(),
      Payment.find({status: "pending"}).lean<PaymentDoc[]>(),
      ChainActivity.find({}).sort({blockNumber: -1, logIndex: -1}).limit(5).lean<ChainActivityDoc[]>(),
    ]);

    const pendingTotals = new Map<string, string>();
    for (const p of pendingPayments) {
      pendingTotals.set(p.currency, addAmounts(pendingTotals.get(p.currency) ?? "0", p.total));
    }
    const pendingSummary =
      pendingPayments.length === 0
        ? "None due"
        : Array.from(pendingTotals.entries())
            .map(([currency, total]) => `${total} ${currency}`)
            .join(" · ");

    const timelineEntries: TimelineEntry[] = recentActivity.map((e) => ({
      id: e.id,
      timestamp: e.blockTimestamp,
      actor: e.operator,
      eventName: e.type,
      txHash: e.txHash,
      chain: "roax",
      detail: e.reasonCode
        ? `Reason: ${reasonCodeLabel(e.reasonCode) ?? e.reasonCode}`
        : e.dogTagId
          ? `dogTagId ${e.dogTagId}`
          : undefined,
    }));

    content = (
      <>
        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile label="Clients" value={String(clientCount)} href="/clients" />
          <StatTile label="Pets" value={String(petCount)} href="/pets" />
          <StatTile label="Active tags" value={String(activeTagCount)} href="/tags" />
          <StatTile label="Today's appointments" value={String(todaysAppointments.length)} href="/calendar" />
          <StatTile label="Payments pending" value={String(pendingPayments.length)} hint={pendingSummary} href="/payments?status=pending" />
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h2 className="mb-3 text-section-title text-ink">Today&apos;s schedule</h2>
            <DataTable
              columns={[
                {key: "when", header: "When", render: (a: AppointmentDoc) => formatUnixSeconds(a.startAt, timeZone)},
                {key: "client", header: "Client", render: (a: AppointmentDoc) => a.clientName},
                {key: "pet", header: "Pet", render: (a: AppointmentDoc) => a.petName},
                {
                  key: "status",
                  header: "Status",
                  render: (a: AppointmentDoc) => <StatusBadge tone={appointmentStatusTone[a.status]} label={appointmentStatusLabel[a.status]} />,
                },
              ]}
              rows={todaysAppointments}
              getRowKey={(a) => a.appointmentId}
              emptyMessage="Nothing on the schedule today."
            />
          </div>

          <div>
            <h2 className="mb-3 text-section-title text-ink">Recent on-chain activity</h2>
            <Timeline entries={timelineEntries} timeZone={timeZone} emptyMessage="No on-chain activity yet." />
            {timelineEntries.length > 0 && (
              <Link href="/activity" className="mt-3 inline-block text-body text-link hover:underline">
                View all activity
              </Link>
            )}
          </div>
        </div>
      </>
    );
  } catch {
    // No MONGODB_URI configured yet (fresh checkout) - render the dashboard without clinic state
    // rather than crashing the page; the banner below still tells the operator what to do.
  }

  return (
    <>
      <PageHeader title="Dashboard" description="Your clinic's DogTag deployment at a glance." />
      {notice === "vet-required" && (
        // WP4.7 A2: `/tags` and `/tags/issue` redirect here rather than a bare 403 - see those
        // pages' own doc comments. No `dismissKey` - this is a one-time redirect notice, not a
        // standing condition to remember dismissing.
        <Banner tone="warn" title="Vet or owner access required">
          DogTag issuance (Tags, Issue tag) is only visible to staff with the Vet or Owner role.
          Ask an owner to change your role in Settings if you need access.
        </Banner>
      )}
      {!cloneConfigured && (
        <Banner
          tone="warn"
          title="Setup is not complete"
          dismissKey="setup-incomplete"
          action={
            <Link
              href="/setup"
              className="inline-flex items-center justify-center rounded-control border border-border-strong bg-surface px-4 py-2 text-body font-medium text-ink hover:bg-surface-2"
            >
              Open setup wizard
            </Link>
          }
        >
          Connect a wallet and discover this clinic&apos;s VetIssuer clone to start issuing tags.
        </Banner>
      )}
      <div className="mt-6">{content}</div>
    </>
  );
}
