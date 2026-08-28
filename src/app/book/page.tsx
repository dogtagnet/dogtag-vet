import {connectToDatabase} from "@/lib/db";
import {Service, type ServiceDoc} from "@/lib/models/Service";
import {getBookingSettings} from "@/lib/models/Availability";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {BookingWizard, type BookableService} from "@/app/book/BookingWizard";

// This page has no dynamic route segment, so without this it is otherwise eligible for Next's
// static-by-default prerendering at build time - which would try to `connectToDatabase()` during
// `next build` itself (no `MONGODB_URI` in that environment) rather than per-request, the way
// every DB-backed page in this app is meant to run. Every other DB-backed page either sits under
// the `(app)` layout (whose own `auth()` cookie read already forces the whole subtree dynamic) or
// has a dynamic `[id]`-style segment (never statically generated without `generateStaticParams`);
// this is the one public page that is neither, so it opts in explicitly.
export const dynamic = "force-dynamic";

/**
 * `/book` - the public-facing booking form (wp4-vet.md's public-booking bullet: "services list,
 * availability, book"). Renders on top of the wire-authoritative JSON routes
 * (`GET /v1/booking/services`, `GET /v1/booking/availability`, `POST /v1/booking/book` -
 * `vet-public-api.yaml`) rather than re-implementing their logic: the service list below uses the
 * SAME `{active: true, bookableOnline: true}` filter as `GET /v1/booking/services` (so this page
 * never offers something the API would refuse), and the wizard itself talks to those same public
 * routes directly for availability and submission.
 */
export default async function BookPage() {
  await connectToDatabase();
  const [services, bookingSettings, settings] = await Promise.all([
    Service.find({active: true, bookableOnline: true}).sort({name: 1}).lean<ServiceDoc[]>(),
    getBookingSettings(),
    getClinicSettings(),
  ]);

  const bookableServices: BookableService[] = services.map((s) => ({
    id: s.serviceId,
    name: s.name,
    description: s.description,
    durationMinutes: s.durationMinutes,
    price: s.price,
  }));

  return (
    <main className="mx-auto max-w-xl space-y-6 p-6">
      <header className="space-y-1">
        <p className="text-caption uppercase tracking-wide text-ink-faint">{settings.businessProfile.name ?? "Book an appointment"}</p>
        <h1 className="text-page-title text-ink">Book an appointment</h1>
        <p className="text-body text-ink-muted">Pick a service and a time that works for you.</p>
      </header>

      <BookingWizard
        services={bookableServices}
        timeZone={bookingSettings.timezone}
        minNoticeMinutes={bookingSettings.minNoticeMinutes}
        maxAdvanceDays={bookingSettings.maxAdvanceDays}
      />
    </main>
  );
}
