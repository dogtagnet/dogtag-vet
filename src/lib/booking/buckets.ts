/**
 * Fixed-size, globally-aligned time buckets (anchored at the Unix epoch, independent of any
 * clinic's timezone or of `BookingSettings.slotGranularityMinutes`) used purely as the unit of
 * atomic capacity reservation in `book.ts`. Small enough that a typical appointment's buffered
 * footprint spans only a handful of buckets.
 */
export const CAPACITY_BUCKET_SECONDS = 300; // 5 minutes

/** Every bucket key an occupied interval `[start, end)` touches, in ascending order. Ascending,
 * globally-consistent order is what lets `bookSlot` acquire multiple buckets without a
 * lock-ordering deadlock/livelock between two racing requests that share more than one bucket
 * (see `book.ts`). */
export function bucketKeysForInterval(start: number, end: number, bucketSeconds = CAPACITY_BUCKET_SECONDS): string[] {
  if (end <= start) return [];
  const firstBucket = Math.floor(start / bucketSeconds);
  const lastBucket = Math.floor((end - 1) / bucketSeconds); // end is exclusive
  const keys: string[] = [];
  for (let bucket = firstBucket; bucket <= lastBucket; bucket++) keys.push(String(bucket));
  return keys;
}
