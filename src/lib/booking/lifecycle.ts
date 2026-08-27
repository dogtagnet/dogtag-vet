import "server-only";
import {bookSlot} from "@/lib/booking/book";
import {localDateMinuteToUtcSeconds, utcSecondsToLocalDateStr, utcSecondsToLocalMinuteOfDay} from "@/lib/booking/dst";
import {mongoBookingStore, releaseAppointmentBuckets, type AppointmentDraft} from "@/lib/booking/mongoStore";
import {loadAvailabilityConfig} from "@/lib/booking/queries";
import {findCoveringWindow, openWindowsForDate} from "@/lib/booking/windows";
import {Appointment, type AppointmentDoc, type AppointmentStatus} from "@/lib/models/Appointment";
import {Service, type ServiceDoc} from "@/lib/models/Service";

const CAPACITY_RELEASING_STATUSES: AppointmentStatus[] = ["cancelled", "no_show"];

/** Effectively unlimited - used so a staff booking's `reserveBucket` call always succeeds (never
 * blocked by capacity: staff can already see the calendar and choose to double-book deliberately,
 * e.g. a walk-in emergency) while still recording the claim, so a later PUBLIC booking request
 * correctly sees the slot as occupied. See `createAppointment`'s doc comment. */
const UNBOUNDED_CAPACITY = Number.MAX_SAFE_INTEGER;

export type CreateAppointmentResult =
  | {ok: true; appointment: AppointmentDoc}
  | {ok: false; reason: "slot_conflict"}
  | {ok: false; reason: "outside_hours"};

/**
 * The single chokepoint every appointment creation goes through - staff and public booking alike
 * - so the capacity-bucket ledger (`CapacityBucket`, reserved by `bookSlot`) and the
 * overlapping-appointment count the availability read path computes from never drift apart. Two
 * independent accountings of the same capacity that aren't kept in sync by construction WILL
 * disagree: an appointment created any other way (a direct `Appointment.create`, a seed script)
 * reserves no buckets, so availability correctly hides the slot while a public booking request
 * finds the bucket empty and books directly on top of it.
 *
 * `enforceCapacity: false` (staff bookings) reserves the same buckets at `UNBOUNDED_CAPACITY`
 * instead of skipping reservation altogether - the claim must still land in the ledger even
 * though this particular request can never be rejected by it.
 */
export async function createAppointment(
  draft: AppointmentDraft,
  options: {enforceCapacity: boolean},
): Promise<CreateAppointmentResult> {
  const service = draft.serviceId ? await Service.findOne({serviceId: draft.serviceId}).lean<ServiceDoc>() : null;
  const bufferBeforeMin = service?.bufferBeforeMin ?? 0;
  const bufferAfterMin = service?.bufferAfterMin ?? 0;
  const occupied = {
    start: draft.startAt - bufferBeforeMin * 60,
    end: draft.endAt + bufferAfterMin * 60,
  };

  let capacity = UNBOUNDED_CAPACITY;
  if (options.enforceCapacity) {
    const config = await loadAvailabilityConfig();
    const localDate = utcSecondsToLocalDateStr(draft.startAt, config.settings.timezone);
    const startMinute = utcSecondsToLocalMinuteOfDay(draft.startAt, config.settings.timezone);
    const durationMinutes = Math.round((draft.endAt - draft.startAt) / 60);
    const windows = openWindowsForDate(localDate, config.rules, config.exceptions);
    const window = findCoveringWindow(windows, startMinute - bufferBeforeMin, startMinute + durationMinutes + bufferAfterMin);
    if (!window) return {ok: false, reason: "outside_hours"};
    // Reject a startAt that doesn't land on a real local instant (DST gap) up front, same as the
    // read path silently drops such candidates rather than ever offering them.
    if (localDateMinuteToUtcSeconds(localDate, startMinute, config.settings.timezone) !== draft.startAt) {
      return {ok: false, reason: "outside_hours"};
    }
    capacity = window.capacity;
  }

  const result = await bookSlot(mongoBookingStore, draft, {occupied, capacity});
  if (!result.ok) return {ok: false, reason: "slot_conflict"};
  return {ok: true, appointment: result.record};
}

/**
 * The single chokepoint every cancellation/no-show goes through, releasing the capacity the
 * appointment held so the slot reopens for booking. Flipping between the two capacity-releasing
 * terminal statuses (e.g. cancelled -> no_show after the fact) does not double-release.
 */
export async function setAppointmentTerminalStatus(
  appointmentId: string,
  status: "cancelled" | "no_show",
): Promise<AppointmentDoc | null> {
  const appointment = await Appointment.findOne({appointmentId}).lean<AppointmentDoc>();
  if (!appointment) return null;

  await Appointment.updateOne({appointmentId}, {$set: {status}});

  if (CAPACITY_RELEASING_STATUSES.includes(appointment.status)) {
    return {...appointment, status};
  }
  const service = appointment.serviceId
    ? await Service.findOne({serviceId: appointment.serviceId}).lean<ServiceDoc>()
    : null;
  await releaseAppointmentBuckets(appointment, service?.bufferBeforeMin ?? 0, service?.bufferAfterMin ?? 0);
  return {...appointment, status};
}
