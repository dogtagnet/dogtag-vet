import {dayOfWeekForDateStr} from "@/lib/booking/dst";
import type {
  AvailabilityExceptionLike,
  AvailabilityRuleLike,
  ResolvedWindow,
} from "@/lib/booking/types";

/**
 * The open windows for one clinic-local calendar date, after a matching exception (if any)
 * overrides the weekly rules: `closed` yields no windows regardless of what the weekly rules say;
 * a set of replacement `windows` supersedes the weekly rules entirely for that date; no exception
 * at all falls back to whichever weekly rules match that date's day-of-week.
 */
export function openWindowsForDate(
  dateStr: string,
  rules: AvailabilityRuleLike[],
  exceptions: AvailabilityExceptionLike[],
): ResolvedWindow[] {
  const exception = exceptions.find((e) => e.date === dateStr);
  if (exception) {
    if (exception.closed) return [];
    return (exception.windows ?? []).map((w) => ({
      startMinute: w.startMinute,
      endMinute: w.endMinute,
      capacity: w.capacity,
    }));
  }
  const dayOfWeek = dayOfWeekForDateStr(dateStr);
  return rules
    .filter((r) => r.dayOfWeek === dayOfWeek)
    .map((r) => ({startMinute: r.startMinute, endMinute: r.endMinute, capacity: r.capacity}));
}

/**
 * The single open window (if any) whose business hours fully contain the given occupied
 * (buffered) interval - used server-side, at write time, to look up the capacity that governs a
 * *specific requested* booking, the same way `generateCandidateSlots` does for the read
 * (availability-listing) path. Returns `null` when no configured window covers the request at
 * all (outside business hours, inside a closed exception, etc.) - callers treat that as an
 * invalid request (400), never as a capacity conflict (409).
 */
export function findCoveringWindow(
  windows: ResolvedWindow[],
  occupiedStartMinute: number,
  occupiedEndMinute: number,
): ResolvedWindow | null {
  return (
    windows.find((w) => occupiedStartMinute >= w.startMinute && occupiedEndMinute <= w.endMinute) ?? null
  );
}

export interface CandidateSlot {
  startMinute: number;
  endMinute: number;
  /** Start of the occupied (buffered) footprint, in minutes since local midnight. */
  occupiedStartMinute: number;
  /** End of the occupied (buffered) footprint, in minutes since local midnight. */
  occupiedEndMinute: number;
  capacity: number;
}

/**
 * Candidate slot start times within one date's open windows, stepped at `granularityMinutes`.
 * A candidate is only included when its full occupied footprint (the service duration plus its
 * before/after buffers) fits inside a single open window - buffers never spill past business
 * hours into a closed period.
 */
export function generateCandidateSlots(
  windows: ResolvedWindow[],
  granularityMinutes: number,
  durationMinutes: number,
  bufferBeforeMin: number,
  bufferAfterMin: number,
): CandidateSlot[] {
  const candidates: CandidateSlot[] = [];
  for (const window of windows) {
    for (
      let start = window.startMinute;
      start + durationMinutes <= window.endMinute;
      start += granularityMinutes
    ) {
      const occupiedStart = start - bufferBeforeMin;
      const occupiedEnd = start + durationMinutes + bufferAfterMin;
      if (occupiedStart < window.startMinute || occupiedEnd > window.endMinute) continue;
      candidates.push({
        startMinute: start,
        endMinute: start + durationMinutes,
        occupiedStartMinute: occupiedStart,
        occupiedEndMinute: occupiedEnd,
        capacity: window.capacity,
      });
    }
  }
  return candidates;
}
