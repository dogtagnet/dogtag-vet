import {PageHeader} from "@/components/shell/PageHeader";
import {calendarRangeFor, startOfWeek} from "@/lib/booking/calendarRange";
import {getBookingSettings, AvailabilityRule, type AvailabilityRuleDoc} from "@/lib/models/Availability";
import {connectToDatabase} from "@/lib/db";
import {Appointment, type AppointmentDoc} from "@/lib/models/Appointment";
import {Service, type ServiceDoc} from "@/lib/models/Service";
import {CalendarView} from "@/components/calendar/CalendarView";

function todayInTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {timeZone, year: "numeric", month: "2-digit", day: "2-digit"}).format(
    new Date(),
  );
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{date?: string; view?: "week" | "day"}>;
}) {
  const {date, view = "week"} = await searchParams;
  await connectToDatabase();
  const settings = await getBookingSettings();
  const anchor = date ?? todayInTimeZone(settings.timezone);
  const rangeStart = view === "day" ? anchor : startOfWeek(anchor);
  const days = view === "day" ? 1 : 7;
  const range = calendarRangeFor(rangeStart, days, settings.timezone);

  const [appointments, services, rules] = await Promise.all([
    Appointment.find({startAt: {$lt: range.toUtc}, endAt: {$gt: range.fromUtc}})
      .sort({startAt: 1})
      .lean<AppointmentDoc[]>(),
    Service.find({active: true}).sort({name: 1}).lean<ServiceDoc[]>(),
    AvailabilityRule.find({}).lean<AvailabilityRuleDoc[]>(),
  ]);

  const dayStartMinute = rules.length ? Math.min(...rules.map((r) => r.startMinute), 480) : 480;
  const dayEndMinute = rules.length ? Math.max(...rules.map((r) => r.endMinute), 1080) : 1080;

  return (
    <>
      <PageHeader title="Calendar" description="Click an open slot to book an appointment." />
      <CalendarView
        dates={range.dates}
        timezone={settings.timezone}
        view={view}
        anchorDate={anchor}
        dayStartMinute={dayStartMinute}
        dayEndMinute={dayEndMinute}
        appointments={appointments.map((a) => ({
          appointmentId: a.appointmentId,
          startAt: a.startAt,
          endAt: a.endAt,
          status: a.status,
          clientName: a.clientName,
          petName: a.petName,
          serviceId: a.serviceId,
        }))}
        services={services.map((s) => ({serviceId: s.serviceId, name: s.name, durationMinutes: s.durationMinutes}))}
      />
    </>
  );
}
