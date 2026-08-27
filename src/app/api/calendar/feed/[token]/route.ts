import {buildIcsCalendar} from "@/lib/ics";
import {connectToDatabase} from "@/lib/db";
import {Appointment, type AppointmentDoc} from "@/lib/models/Appointment";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {Service, type ServiceDoc} from "@/lib/models/Service";
import {enforceRateLimit} from "@/lib/publicApi";

/**
 * `GET /api/calendar/feed/:token` - read-only ics feed of this clinic's non-cancelled
 * appointments, for subscribing in an external calendar app. Gated by a rotatable bearer token
 * carried in the path (v1 pattern, matching the mint/verify token shape) rather than a header, so
 * a plain calendar-subscription URL (no custom headers) works. Rotate the token from Settings if
 * a feed URL leaks.
 */
export async function GET(request: Request, {params}: {params: Promise<{token: string}>}) {
  const rateLimit = enforceRateLimit(request, "calendar-feed", 30, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const {token} = await params;
  await connectToDatabase();
  const settings = await getClinicSettings();
  if (!settings.icsFeedToken || settings.icsFeedToken !== token) {
    return new Response("Not found", {status: 404, headers: rateLimit.headers});
  }

  const [appointments, services] = await Promise.all([
    Appointment.find({status: {$nin: ["cancelled"]}})
      .sort({startAt: 1})
      .lean<AppointmentDoc[]>(),
    Service.find({}).lean<ServiceDoc[]>(),
  ]);
  const serviceNameById = new Map(services.map((s) => [s.serviceId, s.name]));
  const clinicName = settings.businessProfile?.name || "Clinic";

  const ics = buildIcsCalendar(
    appointments.map((a) => ({
      uid: `${a.appointmentId}@dogtag-vet`,
      summary: `${a.serviceId ? serviceNameById.get(a.serviceId) ?? "Appointment" : "Appointment"} - ${a.clientName}`,
      description: a.notes,
      startAt: a.startAt,
      endAt: a.endAt,
      status: a.status === "no_show" ? "CANCELLED" : "CONFIRMED",
    })),
    {prodId: `-//dogtag-vet//${clinicName}//EN`},
  );

  return new Response(ics, {
    headers: {
      ...rateLimit.headers,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": "inline; filename=appointments.ics",
    },
  });
}
