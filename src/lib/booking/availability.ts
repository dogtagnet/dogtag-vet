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
