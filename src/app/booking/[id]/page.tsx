import {notFound} from "next/navigation";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {appointmentStatusLabel, appointmentStatusTone} from "@/lib/appointmentTone";
import {computeCancellable, loadServiceName} from "@/lib/booking/appointmentStatus";
import {formatUnixSeconds} from "@/lib/format";
import {connectToDatabase} from "@/lib/db";
import {Appointment, type AppointmentDoc} from "@/lib/models/Appointment";
import {getBookingSettings} from "@/lib/models/Availability";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {BookingManageActions} from "@/app/booking/[id]/BookingManageActions";

/**
 * `/booking/{id}?token=...` - the client-facing HTML status/cancel page wp4-vet.md's public-booking
 * bullet requires ("client-facing status/cancel URL with token"). This is the page a client
 * actually lands on from the confirmation email's "manage or cancel" link
 * (`src/lib/booking/confirmation.ts`); it renders on top of the wire-authoritative JSON contract
 * at `GET /v1/booking/appointments/{id}` and `POST .../cancel` (`vet-public-api.yaml`) rather than
 * duplicating that logic - the initial render reads the appointment directly (server-side, same as
 * every other public page in this app, e.g. `/pay/{id}`), and the Cancel button
 * (`BookingManageActions`) calls the same public JSON cancel route a script or another client would.
 *
 * Deliberately a different route than the JSON endpoint it fronts: `/v1/` is reserved for the
 * wire-authoritative API surface throughout this app (see that route's own doc comment), so a
 * human-facing page answering the same question lives at its own path instead of trying to content-
 * negotiate one route into being both an API and a webpage.
 */
export default async function BookingManagePage({
  params,
  searchParams,
}: {
  params: Promise<{id: string}>;
  searchParams: Promise<{token?: string}>;
}) {
  const {id} = await params;
  const {token} = await searchParams;

  await connectToDatabase();
  const appointment = await Appointment.findOne({appointmentId: id}).lean<AppointmentDoc>();
  if (!appointment || !token || !appointment.cancelToken || appointment.cancelToken !== token) notFound();

  const [serviceName, bookingSettings, settings] = await Promise.all([
    loadServiceName(appointment.serviceId),
    getBookingSettings(),
    getClinicSettings(),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const cancellable = await computeCancellable(appointment, now);

  return (
    <main className="mx-auto max-w-xl space-y-6 p-6">
      <header className="space-y-1">
        <p className="text-caption uppercase tracking-wide text-ink-faint">{settings.businessProfile.name ?? "Appointment"}</p>
        <h1 className="text-page-title text-ink">{serviceName}</h1>
        <StatusBadge tone={appointmentStatusTone[appointment.status]} label={appointmentStatusLabel[appointment.status]} />
      </header>

      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <p className="text-caption uppercase tracking-wide text-ink-muted">When</p>
        <p className="mt-1 text-emphasized text-ink">{formatUnixSeconds(appointment.startAt, bookingSettings.timezone, true)}</p>
        {appointment.petName && (
          <>
            <p className="mt-4 text-caption uppercase tracking-wide text-ink-muted">Pet</p>
            <p className="mt-1 text-body text-ink">{appointment.petName}</p>
          </>
        )}
      </div>

      <BookingManageActions appointmentId={appointment.appointmentId} token={token} cancellable={cancellable} status={appointment.status} />
    </main>
  );
}
