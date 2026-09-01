import {addCalendarDays, localDateMinuteToUtcSeconds, utcSecondsToLocalDateStr} from "@/lib/booking/dst";
import {countOverlapping} from "@/lib/booking/occupied";
import {generateCandidateSlots, openWindowsForDate} from "@/lib/booking/windows";
import type {
  AvailabilityExceptionLike,
  AvailabilityRuleLike,
  AvailableSlot,
  BookingSettingsLike,
  OccupiedInterval,
  ServiceForAvailability,
} from "@/lib/booking/types";

export interface ComputeAvailabilityParams {
  service: ServiceForAvailability;
  rules: AvailabilityRuleLike[];
  exceptions: AvailabilityExceptionLike[];
  settings: BookingSettingsLike;
  /** Already-buffered busy intervals for every non-cancelled appointment that could plausibly
   * overlap the range (any service - capacity is shared clinic-wide, not per-service). */
  existingOccupied: OccupiedInterval[];
  /** Inclusive range start, UTC unix seconds. */
  fromUtc: number;
  /** Exclusive range end, UTC unix seconds. */
  toUtc: number;
  /** Injected rather than read from the clock, so minNotice/maxAdvance filtering is deterministic
   * and testable. */
  now: number;
}

/**
 * The pure heart of the booking system: every open slot for one service across a UTC instant
 * range, honoring weekly rules, date exceptions, per-slot capacity, buffers, granularity,
 * minNotice/maxAdvance, and already-booked (non-cancelled) appointments. Timezone-correct - all
 * business-hours math happens in clinic-local minutes-since-midnight; only the final slot
 * boundaries are converted to UTC, with a DST round-trip guard silently dropping any candidate
 * that lands on a wall-clock time the local calendar never had (see `dst.ts`).
 */
export function computeAvailability(params: ComputeAvailabilityParams): AvailableSlot[] {
  const {service, rules, exceptions, settings, existingOccupied, fromUtc, toUtc, now} = params;
  if (toUtc <= fromUtc) return [];

  const minStart = now + settings.minNoticeMinutes * 60;
  const maxStart = now + settings.maxAdvanceDays * 86400;

  const startDate = utcSecondsToLocalDateStr(fromUtc, settings.timezone);
  // toUtc is exclusive; the last instant actually in range is toUtc - 1.
  const endDate = utcSecondsToLocalDateStr(Math.max(fromUtc, toUtc - 1), settings.timezone);

  const slots: AvailableSlot[] = [];
  let cursor = startDate;
  // One extra day of slack on each side: a local calendar date's evening can map to the next
  // UTC date (and vice versa), so scanning exactly [startDate, endDate] could miss slots near
  // the range boundary. Slots outside [fromUtc, toUtc) are filtered out below regardless.
  const scanStart = addCalendarDays(startDate, -1);
  const scanEnd = addCalendarDays(endDate, 1);
  cursor = scanStart;

  // Bound the loop generously (a 31-day range plus 2 days of slack) rather than trusting caller
  // input alone - this is a pure library and must never spin forever on a malformed range.
  for (let guard = 0; guard < 400 && cursor <= scanEnd; guard++) {
    const windows = openWindowsForDate(cursor, rules, exceptions);
    const candidates = generateCandidateSlots(
      windows,
      settings.slotGranularityMinutes,
      service.durationMinutes,
      service.bufferBeforeMin,
      service.bufferAfterMin,
    );

    for (const candidate of candidates) {
      const startAt = localDateMinuteToUtcSeconds(cursor, candidate.startMinute, settings.timezone);
      const endAt = localDateMinuteToUtcSeconds(cursor, candidate.endMinute, settings.timezone);
      if (startAt === null || endAt === null) continue;
      if (startAt < fromUtc || startAt >= toUtc) continue;
      if (startAt < minStart || startAt > maxStart) continue;

      const occupiedStart = startAt - service.bufferBeforeMin * 60;
      const occupiedEnd = endAt + service.bufferAfterMin * 60;
      const overlap = countOverlapping({start: occupiedStart, end: occupiedEnd}, existingOccupied);
      if (overlap >= candidate.capacity) continue;

      slots.push({startAt, endAt, capacity: candidate.capacity - overlap});
    }

    cursor = addCalendarDays(cursor, 1);
  }

  slots.sort((a, b) => a.startAt - b.startAt);
  return slots;
}

export interface PractitionerAvailabilityInput {
  staffId: string;
  /** This practitioner's OWN rules/exceptions only (`staffId`-matched, plus staffId-absent
   * exceptions - see this function's own doc comment on the closures asymmetry) - pre-filtered by
   * the caller (`queries.ts`), never filtered here. */
  rules: AvailabilityRuleLike[];
  exceptions: AvailabilityExceptionLike[];
  /** This practitioner's own occupied intervals: their own appointments PLUS every UNASSIGNED
   * appointment (D3 - "unassigned blocks ALL practitioners"), already buffered by the caller
   * exactly like `ComputeAvailabilityParams.existingOccupied`. */
  occupied: OccupiedInterval[];
}

export interface ComputePractitionerAvailabilityParams {
  service: ServiceForAvailability;
  practitioners: PractitionerAvailabilityInput[];
  settings: BookingSettingsLike;
  fromUtc: number;
  toUtc: number;
  now: number;
}

export interface PractitionerAvailableSlot {
  startAt: number;
  endAt: number;
  /** Every practitioner free at this exact instant, sorted ascending for determinism. Non-empty by
   * construction - "a slot exists iff practitionerIds is non-empty" (A4): a `[startAt, endAt)` no
   * practitioner is free at is simply never added to the map below. */
  practitionerIds: string[];
}

/**
 * WP4.7 A4/D1/D2: the per-practitioner counterpart of `computeAvailability`, used only when
 * `BookingSettings.schedulingMode === "practitioner"`. Deliberately calls `computeAvailability`
 * ONCE PER PRACTITIONER rather than reimplementing its day/window/candidate-slot scan -
 * Whole-clinic mode's own path (`computeAvailability` itself, above) is completely untouched by
 * this WP, byte-for-byte identical to before it (proven by `tests/unit/availability.test.ts`
 * passing with ZERO edits to its own expectations), and this function's correctness rests on
 * reusing that exact same, already-proven engine per practitioner rather than a second, subtly
 * different reimplementation of the same day/window/DST/buffer logic.
 *
 * D2: "a practitioner's capacity is intrinsically 1" - regardless of whatever `capacity` value
 * happens to be stored on a practitioner-scoped rule/exception window (the settings UI, A5, is not
 * trusted to always send 1; this is an ENGINE-level invariant). Every rule and exception window
 * passed into `computeAvailability` below has its `capacity` forced to 1 here, before the call -
 * `computeAvailability` itself never has to know practitioner mode exists.
 *
 * A slot's `practitionerIds` is every practitioner `computeAvailability` returned a slot for at
 * that exact `[startAt, endAt)` - the union. D3's "unassigned blocks everyone" rule is encoded
 * entirely in each practitioner's own `occupied` INPUT (the caller is responsible for including
 * every unassigned appointment in every practitioner's list), so this function needs no separate
 * "unassigned" handling of its own.
 */
export function computePractitionerAvailability(params: ComputePractitionerAvailabilityParams): PractitionerAvailableSlot[] {
  const {service, practitioners, settings, fromUtc, toUtc, now} = params;

  // Keyed on `startAt` alone (not a composite string key) - `noUncheckedIndexedAccess` makes
  // splitting a composite key back into numbers awkward (`string | undefined`), and startAt alone
  // is already a sufficient key: every candidate for a single `service` (fixed durationMinutes)
  // has an `endAt` fully determined by its `startAt`.
  const byStart = new Map<number, {endAt: number; staffIds: Set<string>}>();

  for (const practitioner of practitioners) {
    const forcedCapacityRules = practitioner.rules.map((rule) => ({...rule, capacity: 1}));
    const forcedCapacityExceptions = practitioner.exceptions.map((exception) => ({
      ...exception,
      windows: exception.windows?.map((w) => ({...w, capacity: 1})),
    }));

    const slots = computeAvailability({
      service,
      rules: forcedCapacityRules,
      exceptions: forcedCapacityExceptions,
      settings,
      existingOccupied: practitioner.occupied,
      fromUtc,
      toUtc,
      now,
    });

    for (const slot of slots) {
      const entry = byStart.get(slot.startAt);
      if (entry) entry.staffIds.add(practitioner.staffId);
      else byStart.set(slot.startAt, {endAt: slot.endAt, staffIds: new Set([practitioner.staffId])});
    }
  }

  return Array.from(byStart.entries())
    .map(([startAt, {endAt, staffIds}]) => ({startAt, endAt, practitionerIds: Array.from(staffIds).sort()}))
    .sort((a, b) => a.startAt - b.startAt);
}
