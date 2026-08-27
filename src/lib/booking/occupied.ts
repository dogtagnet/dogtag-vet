import type {OccupiedInterval} from "@/lib/booking/types";

/** Half-open interval overlap: `[aStart, aEnd)` intersects `[bStart, bEnd)`. Touching endpoints
 * (one ends exactly when the other starts) do not count as overlapping - back-to-back
 * appointments with zero buffer are allowed to sit flush against each other. */
export function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** How many of `existing` occupied intervals overlap `candidate`. Used both to filter available
 * slots (capacity - overlapCount > 0) and, on the write path, to decide whether a just-inserted
 * appointment fits within capacity (see `book.ts`). */
export function countOverlapping(candidate: OccupiedInterval, existing: OccupiedInterval[]): number {
  let count = 0;
  for (const interval of existing) {
    if (intervalsOverlap(candidate.start, candidate.end, interval.start, interval.end)) count++;
  }
  return count;
}
