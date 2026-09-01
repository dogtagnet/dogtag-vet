import Link from "next/link";
import {PageHeader} from "@/components/shell/PageHeader";
import {DataTable} from "@/components/ui/DataTable";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {formatUnixSeconds} from "@/lib/format";
import {appointmentSourceLabel, appointmentStatusLabel, appointmentStatusTone} from "@/lib/appointmentTone";
import {robustLocalMidnightUtc} from "@/lib/booking/calendarRange";
import {addCalendarDays} from "@/lib/booking/dst";
import {connectToDatabase} from "@/lib/db";
import {getBookingSettings} from "@/lib/models/Availability";
import {Appointment, type AppointmentDoc} from "@/lib/models/Appointment";
import {AppointmentFilters} from "@/app/(app)/appointments/AppointmentFilters";
import {toPlain} from "@/lib/toPlain";

interface AppointmentsSearchParams {
  q?: string;
  status?: string;
  source?: string;
  fromDate?: string;
  toDate?: string;
}

export default async function AppointmentsPage({searchParams}: {searchParams: Promise<AppointmentsSearchParams>}) {
  const {q, status, source, fromDate, toDate} = await searchParams;
  await connectToDatabase();
  const bookingSettings = await getBookingSettings();
  const timeZone = bookingSettings.timezone;

  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  if (source) filter.source = source;
  if (q) {
    const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [{clientName: {$regex: escaped, $options: "i"}}, {petName: {$regex: escaped, $options: "i"}}];
  }
  if (fromDate || toDate) {
    // Clinic-local calendar-day boundaries, not UTC midnight - the same timezone-correctness rule
    // every other date/time surface in this app follows (wp4-vet.md's booking section).
    filter.startAt = {
      ...(fromDate ? {$gte: robustLocalMidnightUtc(fromDate, timeZone)} : {}),
      ...(toDate ? {$lt: robustLocalMidnightUtc(addCalendarDays(toDate, 1), timeZone)} : {}),
    };
  }

  const appointments = await Appointment.find(filter).sort({startAt: 1}).limit(500).lean<AppointmentDoc[]>().then(toPlain);

  return (
    <>
      <PageHeader title="Appointments" description="Every booked appointment, staff and public." />
      <AppointmentFilters />
      <DataTable
        columns={[
          {
            key: "when",
            header: "When",
            render: (a: AppointmentDoc) => (
              <Link href={`/appointments/${a.appointmentId}`} className="text-link hover:underline">
                {formatUnixSeconds(a.startAt, timeZone)}
              </Link>
            ),
          },
          {
            key: "client",
            header: "Client",
            render: (a: AppointmentDoc) =>
              a.clientId ? (
                <Link href={`/clients/${a.clientId}`} className="text-link hover:underline">
                  {a.clientName}
                </Link>
              ) : (
                a.clientName
              ),
          },
          {key: "pet", header: "Pet", render: (a: AppointmentDoc) => a.petName},
          {
            key: "status",
            header: "Status",
            render: (a: AppointmentDoc) => (
              <StatusBadge tone={appointmentStatusTone[a.status]} label={appointmentStatusLabel[a.status]} />
            ),
          },
          {key: "source", header: "Source", render: (a: AppointmentDoc) => appointmentSourceLabel[a.source]},
        ]}
        rows={appointments}
        getRowKey={(a) => a.appointmentId}
        emptyMessage="No appointments match these filters."
      />
    </>
  );
}

