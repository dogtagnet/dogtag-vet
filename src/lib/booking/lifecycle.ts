import "server-only";
import {bookSlot} from "@/lib/booking/book";
import {calendarRangeFor} from "@/lib/booking/calendarRange";
import {localDateMinuteToUtcSeconds, utcSecondsToLocalDateStr, utcSecondsToLocalMinuteOfDay} from "@/lib/booking/dst";
import {mongoBookingStore, releaseAppointmentBuckets, type AppointmentDraft} from "@/lib/booking/mongoStore";
import {countOverlapping} from "@/lib/booking/occupied";
import {
  countPractitionerAppointmentsInRange,
  listBookablePractitioners,
  loadAvailabilityConfig,
  loadPractitionerOccupiedIntervals,
  loadPractitionerRulesAndExceptions,
} from "@/lib/booking/queries";
import type {BookingSettingsLike, OccupiedInterval} from "@/lib/booking/types";
import {findCoveringWindow, openWindowsForDate} from "@/lib/booking/windows";
import {Appointment, type AppointmentDoc, type AppointmentStatus} from "@/lib/models/Appointment";
import {Service, type ServiceDoc} from "@/lib/models/Service";
import {Staff, type StaffDoc} from "@/lib/models/Staff";

const CAPACITY_RELEASING_STATUSES: AppointmentStatus[] = ["cancelled", "no_show"];

/** Effectively unlimited - used so a staff booking's `reserveBucket` call always succeeds (never
 * blocked by capacity: staff can already see the calendar and choose to double-book deliberately,
 * e.g. a walk-in emergency) while still recording the claim, so a later PUBLIC booking request
 * correctly sees the slot as occupied. See `createAppointment`'s doc comment. */
const UNBOUNDED_CAPACITY = Number.MAX_SAFE_INTEGER;

/** WP4.7 D5: bounded retry ceiling for auto-assign's "try the next candidate on a lost race" loop
 * - a real clinic has a handful of practitioners, never anywhere near this many, so hitting the
 * bound means something is structurally wrong (or under adversarial load), not ordinary contention;
 * either way a request must always terminate rather than loop forever. */
const MAX_AUTO_ASSIGN_ATTEMPTS = 25;

export type CreateAppointmentResult =
  | {ok: true; appointment: AppointmentDoc}
  | {ok: false; reason: "slot_conflict"}
  | {ok: false; reason: "outside_hours"}
  | {ok: false; reason: "invalid_practitioner"};

/** One atomic claim attempt against the bucket ledger - shared by every path below (clinic mode,
 * a named/auto-assigned practitioner, and an unassigned appointment's every-practitioner scope) so
 * there is exactly one place that calls `bookSlot` and persists `bucketScope` onto the draft. */
async function claimAppointment(
  draft: AppointmentDraft,
  occupied: OccupiedInterval,
  capacity: number,
  bucketScope: string[] | undefined,
): Promise<CreateAppointmentResult> {
  const result = await bookSlot(mongoBookingStore, {...draft, bucketScope}, {occupied, capacity, bucketScope});
  if (!result.ok) return {ok: false, reason: "slot_conflict"};
  return {ok: true, appointment: result.record};
}

/** The clinic-mode hours+capacity check - EXACT pre-WP4.7 logic, extracted unchanged so
 * `createAppointment`'s new practitioner-mode branch can sit alongside it without disturbing it. */
function resolveClinicWindow(
  draft: Pick<AppointmentDraft, "startAt" | "endAt">,
  bufferBeforeMin: number,
  bufferAfterMin: number,
  settings: BookingSettingsLike,
  rules: Parameters<typeof openWindowsForDate>[1],
  exceptions: Parameters<typeof openWindowsForDate>[2],
): {ok: true; capacity: number} | {ok: false} {
  const localDate = utcSecondsToLocalDateStr(draft.startAt, settings.timezone);
  const startMinute = utcSecondsToLocalMinuteOfDay(draft.startAt, settings.timezone);
  const durationMinutes = Math.round((draft.endAt - draft.startAt) / 60);
  const windows = openWindowsForDate(localDate, rules, exceptions);
  const window = findCoveringWindow(windows, startMinute - bufferBeforeMin, startMinute + durationMinutes + bufferAfterMin);
  if (!window) return {ok: false};
  // Reject a startAt that doesn't land on a real local instant (DST gap) up front, same as the
  // read path silently drops such candidates rather than ever offering them.
  if (localDateMinuteToUtcSeconds(localDate, startMinute, settings.timezone) !== draft.startAt) return {ok: false};
  return {ok: true, capacity: window.capacity};
}

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
 *
 * WP4.7 A4: dispatches on `BookingSettings.schedulingMode`, read fresh on every call (never cached)
 * so a mode switch takes effect on the very next booking attempt. Whole-clinic mode's own branch
 * below is the EXACT pre-WP4.7 logic, untouched - `loadAvailabilityConfig` itself was fixed (see
 * its own doc comment) to exclude practitioner-scoped rows, which is what keeps this branch
 * byte-identical even once practitioner-scoped data exists in the database. Practitioner mode adds
 * three sub-paths: a NAMED (or already-resolved-by-auto-assign) practitioner, an UNASSIGNED
 * staff-created appointment (blocks every currently bookable practitioner - D3), and a public/
 * mobile request with no requested practitioner (deterministic auto-assign - D5, `autoAssignAndCreate`
 * below).
 */
export async function createAppointment(
  draft: AppointmentDraft,
  options: {enforceCapacity: boolean},
): Promise<CreateAppointmentResult> {
  const service = draft.serviceId ? await Service.findOne({serviceId: draft.serviceId}).lean<ServiceDoc>() : null;
  const bufferBeforeMin = service?.bufferBeforeMin ?? 0;
  const bufferAfterMin = service?.bufferAfterMin ?? 0;
  const occupied: OccupiedInterval = {
    start: draft.startAt - bufferBeforeMin * 60,
    end: draft.endAt + bufferAfterMin * 60,
  };

  const config = await loadAvailabilityConfig();

  if (config.settings.schedulingMode !== "practitioner") {
    let capacity = UNBOUNDED_CAPACITY;
    if (options.enforceCapacity) {
      const resolved = resolveClinicWindow(draft, bufferBeforeMin, bufferAfterMin, config.settings, config.rules, config.exceptions);
      if (!resolved.ok) return {ok: false, reason: "outside_hours"};
      capacity = resolved.capacity;
    }
    return claimAppointment(draft, occupied, capacity, undefined);
  }

  // ── Practitioner mode from here on (D1/D2/D3/D5). ──────────────────────────────────────────
  if (draft.practitionerStaffId) {
    const staffId = draft.practitionerStaffId;
    const practitioner = await Staff.findOne({
      staffId,
      role: {$in: ["vet", "owner"]},
      bookable: true,
      disabled: false,
    }).lean<StaffDoc>();
    if (!practitioner) return {ok: false, reason: "invalid_practitioner"};

    let capacity = UNBOUNDED_CAPACITY;
    if (options.enforceCapacity) {
      const rulesMap = await loadPractitionerRulesAndExceptions([staffId]);
      const own = rulesMap.get(staffId) ?? {rules: [], exceptions: []};
      const resolved = resolveClinicWindow(draft, bufferBeforeMin, bufferAfterMin, config.settings, own.rules, own.exceptions);
      if (!resolved.ok) return {ok: false, reason: "outside_hours"};
      capacity = 1; // D2: a practitioner's capacity is intrinsically 1, regardless of the stored window's own capacity value.
    }
    return claimAppointment(draft, occupied, capacity, [staffId]);
  }

  if (!options.enforceCapacity) {
    // Staff-created, deliberately unassigned appointment - D3: blocks every CURRENTLY bookable
    // practitioner. Unbounded capacity (same staff-override reasoning as clinic mode above) - the
    // claim still lands in the ledger so a later enforced-capacity request correctly sees every
    // practitioner as busy at this time.
    const bookable = await listBookablePractitioners();
    return claimAppointment(draft, occupied, UNBOUNDED_CAPACITY, bookable.map((p) => p.staffId));
  }

  // Public/mobile booking, practitioner mode, no requested practitioner: deterministic auto-assign.
  return autoAssignAndCreate(draft, occupied, bufferBeforeMin, bufferAfterMin, config.settings);
}

/**
 * WP4.7 D5: "Absent practitionerId -> server auto-assigns deterministically (free practitioners
 * sorted by fewest appointments that day, tie-break by staffId). ... retry next candidate on a
 * lost race (bounded), else 409." Candidate selection re-reads hours and occupancy fresh (the
 * caller's own availability read, if any, could be stale by the time this request lands); the
 * FINAL word on whether a given candidate actually got the slot is still the atomic bucket claim
 * in `claimAppointment` - candidate selection only decides trial ORDER, it does not itself grant
 * anything.
 */
async function autoAssignAndCreate(
  draft: AppointmentDraft,
  occupied: OccupiedInterval,
  bufferBeforeMin: number,
  bufferAfterMin: number,
  settings: BookingSettingsLike,
): Promise<CreateAppointmentResult> {
  const bookable = await listBookablePractitioners();
  if (bookable.length === 0) return {ok: false, reason: "slot_conflict"};
  const staffIds = bookable.map((p) => p.staffId);

  const localDate = utcSecondsToLocalDateStr(draft.startAt, settings.timezone);
  const startMinute = utcSecondsToLocalMinuteOfDay(draft.startAt, settings.timezone);
  const durationMinutes = Math.round((draft.endAt - draft.startAt) / 60);
  if (localDateMinuteToUtcSeconds(localDate, startMinute, settings.timezone) !== draft.startAt) {
    return {ok: false, reason: "outside_hours"};
  }

  const [rulesMap, occupiedMap] = await Promise.all([
    loadPractitionerRulesAndExceptions(staffIds),
    loadPractitionerOccupiedIntervals(occupied.start, occupied.end, staffIds),
  ]);

  const freeCandidates = staffIds.filter((staffId) => {
    const own = rulesMap.get(staffId) ?? {rules: [], exceptions: []};
    const windows = openWindowsForDate(localDate, own.rules, own.exceptions);
    const window = findCoveringWindow(windows, startMinute - bufferBeforeMin, startMinute + durationMinutes + bufferAfterMin);
    if (!window) return false;
    const occupiedList = occupiedMap.get(staffId) ?? [];
    return countOverlapping(occupied, occupiedList) < 1; // D2: capacity 1
  });
  if (freeCandidates.length === 0) return {ok: false, reason: "slot_conflict"};

  const {fromUtc: dayStart, toUtc: dayEnd} = calendarRangeFor(localDate, 1, settings.timezone);
  const counts = await Promise.all(freeCandidates.map((staffId) => countPractitionerAppointmentsInRange(staffId, dayStart, dayEnd)));
  const sortedCandidates = freeCandidates
    .map((staffId, i) => ({staffId, count: counts[i] ?? 0}))
    .sort((a, b) => a.count - b.count || a.staffId.localeCompare(b.staffId))
    .map((c) => c.staffId);

  for (const staffId of sortedCandidates.slice(0, MAX_AUTO_ASSIGN_ATTEMPTS)) {
    const attempt = await claimAppointment({...draft, practitionerStaffId: staffId}, occupied, 1, [staffId]);
    if (attempt.ok) return attempt;
    // slot_conflict: lost the race to a concurrent booking for this exact candidate between
    // candidate selection above and this claim - try the next one rather than failing outright.
  }
  return {ok: false, reason: "slot_conflict"};
}

/**
 * The single chokepoint every cancellation/no-show goes through, releasing the capacity the
 * appointment held so the slot reopens for booking. Flipping between the two capacity-releasing
 * terminal statuses (e.g. cancelled -> no_show after the fact) does not double-release.
 *
 * Review finding 1: releasing the slot must also release the SIGNED CLAIM that booked it.
 * `bookingIdentity.bookingHash` is the mobile wallet claim's replay anchor (the booking route's
 * pre-check and the partial unique index both match on it - `models/Appointment.ts`), and it
 * covers only booking CONTENT (service, slot, client fields, tag id - `bookingHash.ts`), so a
 * client who cancels and then legitimately re-books the exact same configuration re-signs to the
 * identical hash and would be told "already used" forever. The `$rename` below moves the hash
 * aside to `bookingIdentity.releasedBookingHash` the moment an appointment goes terminal - kept
 * for audit, never deleted - so replay protection is scoped to NON-TERMINAL appointments by
 * construction: both enforcement layers only ever see the live field. `$rename` is a no-op when
 * the source field is absent (staff appointments with no bookingIdentity, pet-only mobile
 * bookings, or a second terminal flip like cancelled -> no_show), so this needs no guard.
 */
export async function setAppointmentTerminalStatus(
  appointmentId: string,
  status: "cancelled" | "no_show",
): Promise<AppointmentDoc | null> {
  const appointment = await Appointment.findOne({appointmentId}).lean<AppointmentDoc>();
  if (!appointment) return null;

  await Appointment.updateOne(
    {appointmentId},
    {$set: {status}, $rename: {"bookingIdentity.bookingHash": "bookingIdentity.releasedBookingHash"}},
  );

  if (CAPACITY_RELEASING_STATUSES.includes(appointment.status)) {
    return {...appointment, status};
  }
  const service = appointment.serviceId
    ? await Service.findOne({serviceId: appointment.serviceId}).lean<ServiceDoc>()
    : null;
  await releaseAppointmentBuckets(appointment, service?.bufferBeforeMin ?? 0, service?.bufferAfterMin ?? 0);
  return {...appointment, status};
}
