import "server-only";
import {Appointment} from "@/lib/models/Appointment";
import {Service, type ServiceDoc} from "@/lib/models/Service";
import {
  AvailabilityException,
  AvailabilityRule,
  getBookingSettings,
  type AvailabilityExceptionDoc,
  type AvailabilityRuleDoc,
} from "@/lib/models/Availability";
import {Staff, type StaffDoc} from "@/lib/models/Staff";
import {practitionerDisplayName} from "@/lib/staffRoleTone";
import type {
  AvailabilityExceptionLike,
  AvailabilityRuleLike,
  BookingSettingsLike,
  OccupiedInterval,
} from "@/lib/booking/types";

/** Shared by `loadExistingOccupiedIntervals` and `loadPractitionerOccupiedIntervals` - a lookup
 * from `serviceId` to its buffer minutes, plus how far past `[fromUtc, toUtc)` to pad a query so an
 * appointment whose BUFFERED footprint pokes into the requested range (but whose raw `startAt`/
 * `endAt` doesn't) is never missed. Pure extraction, no behavior change to the pre-existing
 * function - both callers still compute the identical numbers they always did. */
async function loadServiceBufferLookup(): Promise<{
  bufferByServiceId: Map<string, {before: number; after: number}>;
  padSeconds: number;
}> {
  const services = await Service.find({}).lean<ServiceDoc[]>();
  const bufferByServiceId = new Map(services.map((s) => [s.serviceId, {before: s.bufferBeforeMin, after: s.bufferAfterMin}]));
  const maxBufferMinutes = services.reduce((max, s) => Math.max(max, s.bufferBeforeMin, s.bufferAfterMin), 0);
  return {bufferByServiceId, padSeconds: (maxBufferMinutes + 5) * 60};
}

/** Every non-cancelled appointment's already-buffered occupied interval that could plausibly
 * overlap `[fromUtc, toUtc)`, for `computeAvailability`'s `existingOccupied` input. Buffers come
 * from each appointment's own service (looked up here, not stored on the appointment itself), so
 * the query window is padded by the largest configured buffer - otherwise an appointment whose
 * buffered footprint pokes into the requested range, but whose raw `startAt`/`endAt` doesn't,
 * would be missed. */
export async function loadExistingOccupiedIntervals(fromUtc: number, toUtc: number): Promise<OccupiedInterval[]> {
  const {bufferByServiceId, padSeconds} = await loadServiceBufferLookup();

  const appointments = await Appointment.find({
    status: {$nin: ["cancelled", "no_show"]},
    startAt: {$lt: toUtc + padSeconds},
    endAt: {$gt: fromUtc - padSeconds},
  })
    .select("startAt endAt serviceId")
    .lean<Array<{startAt: number; endAt: number; serviceId?: string}>>();

  return appointments.map((a) => {
    const buffers = a.serviceId ? bufferByServiceId.get(a.serviceId) : undefined;
    return {
      start: a.startAt - (buffers?.before ?? 0) * 60,
      end: a.endAt + (buffers?.after ?? 0) * 60,
    };
  });
}

export interface PractitionerSummary {
  staffId: string;
  name: string;
}

/** Every currently bookable practitioner (D2: a Staff row with role `vet` or `owner`, `bookable:
 * true`, not disabled) - the roster per-practitioner mode's engine, the availability route's
 * `practitioners[]` (D5), and the auto-assign candidate pool (A4) all operate over. Sorted by
 * `staffId` for a stable, deterministic order (the same tie-break the auto-assign algorithm falls
 * back to). */
export async function listBookablePractitioners(): Promise<PractitionerSummary[]> {
  const staff = await Staff.find({role: {$in: ["vet", "owner"]}, bookable: true, disabled: false}).lean<StaffDoc[]>();
  return staff
    .map((s) => ({staffId: s.staffId, name: practitionerDisplayName(s)}))
    .sort((a, b) => a.staffId.localeCompare(b.staffId));
}

/**
 * WP4.7 D1's precondition for switching `schedulingMode` to "practitioner": at least one bookable
 * practitioner must already have at least one weekly rule of their own, or the public availability
 * response would go from "shows the clinic's hours" to "shows nothing, for anyone, silently" the
 * moment the switch is saved. Enforced here (called from the settings PATCH route) rather than
 * relying on the settings UI alone to prevent the switch - the UI's own guard is a convenience, not
 * the source of truth, matching this codebase's general pattern of defense-in-depth on every
 * consequential write.
 *
 * Short-circuits on an empty practitioner roster rather than letting `AvailabilityRule.exists`
 * run with `staffId: {$in: []}` - that query also correctly matches nothing, but only by an
 * accident of how Mongo treats an empty `$in` array, not because this function said so on purpose.
 */
export async function hasPractitionerReadyForSchedulingMode(): Promise<boolean> {
  const practitioners = await listBookablePractitioners();
  if (practitioners.length === 0) return false;
  const staffIds = practitioners.map((p) => p.staffId);
  return Boolean(await AvailabilityRule.exists({staffId: {$in: staffIds}}));
}

function toRuleLike(rule: AvailabilityRuleDoc): AvailabilityRuleLike {
  return {dayOfWeek: rule.dayOfWeek, startMinute: rule.startMinute, endMinute: rule.endMinute, capacity: rule.capacity};
}

function toExceptionLike(exception: AvailabilityExceptionDoc): AvailabilityExceptionLike {
  return {
    date: exception.date,
    closed: exception.closed,
    windows: exception.windows?.map((w) => ({startMinute: w.startMinute, endMinute: w.endMinute, capacity: w.capacity})),
  };
}

/**
 * Each of `staffIds`' EFFECTIVE rules and exceptions for per-practitioner mode (D2):
 *
 * - Rules are `staffId`-MATCHED ONLY - "their OWN weekly hours". A practitioner with none
 *   configured gets an empty rule list (no availability at all), never a clinic-wide fallback.
 * - Exceptions are the practitioner's OWN (`staffId`-matched) ones FIRST, followed by every
 *   `staffId`-absent (clinic-wide) exception. Order matters: `openWindowsForDate`'s exception
 *   lookup is `.find()` - first match wins - so a practitioner-specific override for a date is
 *   checked BEFORE the clinic-wide fallback for that same date, while a clinic-wide closure (e.g.
 *   a holiday) still closes a practitioner who has no override of their own for it. This is the
 *   one deliberate asymmetry with rules: "a closure without practitioner = whole clinic" (A5/A6)
 *   only makes sense if whole-clinic closures actually apply in practitioner mode too.
 *
 * One query each for rules/exceptions (both small tables, fetched in full - the same approach
 * `loadAvailabilityConfig` already uses) rather than N queries per practitioner.
 */
export async function loadPractitionerRulesAndExceptions(
  staffIds: string[],
): Promise<Map<string, {rules: AvailabilityRuleLike[]; exceptions: AvailabilityExceptionLike[]}>> {
  const [ownRules, allExceptions] = await Promise.all([
    AvailabilityRule.find({staffId: {$in: staffIds}}).lean<AvailabilityRuleDoc[]>(),
    AvailabilityException.find({}).lean<AvailabilityExceptionDoc[]>(),
  ]);
  const clinicWideExceptions = allExceptions.filter((e) => !e.staffId).map(toExceptionLike);

  const map = new Map<string, {rules: AvailabilityRuleLike[]; exceptions: AvailabilityExceptionLike[]}>();
  for (const staffId of staffIds) {
    const rules = ownRules.filter((r) => r.staffId === staffId).map(toRuleLike);
    const ownExceptions = allExceptions.filter((e) => e.staffId === staffId).map(toExceptionLike);
    map.set(staffId, {rules, exceptions: [...ownExceptions, ...clinicWideExceptions]});
  }
  return map;
}

/**
 * Each of `staffIds`' own occupied intervals for `[fromUtc, toUtc)`: their OWN assigned
 * appointments PLUS every UNASSIGNED appointment (D3 - "unassigned blocks ALL practitioners"),
 * already buffered exactly like `loadExistingOccupiedIntervals`. One query for the whole range,
 * partitioned in JS by `practitionerStaffId` rather than N queries per practitioner - the same
 * "small enough to fetch once" reasoning `loadExistingOccupiedIntervals` already relies on.
 */
export async function loadPractitionerOccupiedIntervals(
  fromUtc: number,
  toUtc: number,
  staffIds: string[],
): Promise<Map<string, OccupiedInterval[]>> {
  const {bufferByServiceId, padSeconds} = await loadServiceBufferLookup();

  const appointments = await Appointment.find({
    status: {$nin: ["cancelled", "no_show"]},
    startAt: {$lt: toUtc + padSeconds},
    endAt: {$gt: fromUtc - padSeconds},
  })
    .select("startAt endAt serviceId practitionerStaffId")
    .lean<Array<{startAt: number; endAt: number; serviceId?: string; practitionerStaffId?: string}>>();

  function toOccupied(a: {startAt: number; endAt: number; serviceId?: string}): OccupiedInterval {
    const buffers = a.serviceId ? bufferByServiceId.get(a.serviceId) : undefined;
    return {start: a.startAt - (buffers?.before ?? 0) * 60, end: a.endAt + (buffers?.after ?? 0) * 60};
  }

  const unassigned = appointments.filter((a) => !a.practitionerStaffId).map(toOccupied);

  const map = new Map<string, OccupiedInterval[]>();
  for (const staffId of staffIds) {
    const own = appointments.filter((a) => a.practitionerStaffId === staffId).map(toOccupied);
    map.set(staffId, [...own, ...unassigned]);
  }
  return map;
}

/** Non-cancelled/no-show appointment count for `staffId` on clinic-local calendar date `localDate`
 * - D5's auto-assign tie-break ("fewest appointments that day"). `fromUtc`/`toUtc` are the exact
 * local-day boundary the caller already computed (`calendarRangeFor(localDate, 1, timezone)`),
 * passed in rather than recomputed here so every candidate in one auto-assign attempt is compared
 * against the identical boundary. */
export async function countPractitionerAppointmentsInRange(staffId: string, fromUtc: number, toUtc: number): Promise<number> {
  return Appointment.countDocuments({
    practitionerStaffId: staffId,
    status: {$nin: ["cancelled", "no_show"]},
    startAt: {$gte: fromUtc, $lt: toUtc},
  });
}

export interface AvailabilityConfig {
  settings: BookingSettingsLike;
  rules: AvailabilityRuleLike[];
  exceptions: AvailabilityExceptionLike[];
}

/**
 * The clinic-WIDE availability configuration - small tables, always fetched in full rather than
 * filtered by date range (simpler, and cheap at this scale).
 *
 * WP4.7 A4 correctness fix: filters to `staffId`-ABSENT rows only (`{staffId: {$exists: false}}`),
 * never a bare `find({})` - once ANY practitioner-scoped rule/exception exists in the database (as
 * soon as a clinic has ever configured per-practitioner mode even once, including a clinic that
 * has since switched back to Whole-clinic mode), an unfiltered fetch would silently pull those rows
 * into the clinic-wide computation `openWindowsForDate` merges by `dayOfWeek` alone - widening or
 * otherwise corrupting Whole-clinic mode's hours with a practitioner's SEPARATE schedule. For every
 * environment that has never created a practitioner-scoped row (every environment before this WP,
 * and any clinic that never switches modes), `staffId` never exists on ANY row, so this filter is a
 * no-op and returns byte-identical results to the old unfiltered `find({})` - this is what keeps
 * the clinic-mode byte-parity guarantee (A4) genuinely true rather than only true by accident of
 * nobody having exercised practitioner mode yet.
 */
export async function loadAvailabilityConfig(): Promise<AvailabilityConfig> {
  const [settings, rules, exceptions] = await Promise.all([
    getBookingSettings(),
    AvailabilityRule.find({staffId: {$exists: false}}).lean<AvailabilityRuleLike[]>(),
    AvailabilityException.find({staffId: {$exists: false}}).lean<AvailabilityExceptionLike[]>(),
  ]);
  return {settings, rules, exceptions};
}
