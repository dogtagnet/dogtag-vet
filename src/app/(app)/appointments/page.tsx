import {PageHeader} from "@/components/shell/PageHeader";
import {DataTable} from "@/components/ui/DataTable";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {formatUnixSeconds} from "@/lib/format";
import {appointmentStatusLabel, appointmentStatusTone} from "@/lib/appointmentTone";
import {connectToDatabase} from "@/lib/db";
import {Appointment, type AppointmentDoc} from "@/lib/models/Appointment";
import {AppointmentFilters} from "@/app/(app)/appointments/AppointmentFilters";

interface AppointmentsSearchParams {
  q?: string;
  status?: string;
  fromDate?: string;
  toDate?: string;
}

export default async function AppointmentsPage({searchParams}: {searchParams: Promise<AppointmentsSearchParams>}) {
  const {q, status, fromDate, toDate} = await searchParams;
  await connectToDatabase();

  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  if (q) {
    const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [{clientName: {$regex: escaped, $options: "i"}}, {petName: {$regex: escaped, $options: "i"}}];
  }
  if (fromDate || toDate) {
    filter.startAt = {
      ...(fromDate ? {$gte: Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000)} : {}),
      ...(toDate ? {$lt: Math.floor(new Date(`${toDate}T00:00:00Z`).getTime() / 1000) + 86400} : {}),
    };
  }

  const appointments = await Appointment.find(filter).sort({startAt: 1}).limit(500).lean<AppointmentDoc[]>();

  return (
    <>
      <PageHeader title="Appointments" description="Every booked appointment, staff and public." />
      <AppointmentFilters />
      <DataTable
        columns={[
          {key: "when", header: "When", render: (a: AppointmentDoc) => formatUnixSeconds(a.startAt)},
          {key: "client", header: "Client", render: (a: AppointmentDoc) => a.clientName},
          {key: "pet", header: "Pet", render: (a: AppointmentDoc) => a.petName},
          {
            key: "status",
            header: "Status",
            render: (a: AppointmentDoc) => (
              <StatusBadge tone={appointmentStatusTone[a.status]} label={appointmentStatusLabel[a.status]} />
            ),
          },
          {key: "source", header: "Source", render: (a: AppointmentDoc) => a.source.replace("_", " ")},
        ]}
        rows={appointments}
        getRowKey={(a) => a.appointmentId}
        emptyMessage="No appointments match these filters."
      />
    </>
  );
}

