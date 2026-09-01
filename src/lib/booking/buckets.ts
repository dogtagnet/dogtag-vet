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

/**
 * WP4.7 A4: the practitioner-mode counterpart of `bucketKeysForInterval` - one independent capacity
 * pool PER practitioner in `bucketScope` (`p:<staffId>:<bucket>`) instead of the single clinic-wide
 * pool, so the atomic no-double-book algorithm in `book.ts` applies separately to each
 * practitioner. `bucketScope` absent or empty falls back to the PLAIN clinic-mode keys unchanged -
 * this is what gives clinic mode byte-for-byte identical bucket behavior (and, as a side effect, a
 * completely disjoint key namespace from practitioner mode, so switching `schedulingMode` back and
 * forth can never make an old clinic-wide reservation collide with a new practitioner-scoped one,
 * or vice versa).
 *
 * `bucketScope` is DEDUPLICATED and SORTED before use, deterministically and independent of the
 * order the caller happened to build the list in - this is what preserves `bookSlot`'s
 * ascending-acquisition guarantee (see its own doc comment) across two DIFFERENT callers whose
 * scopes only partially overlap (e.g. a named booking for practitioner B racing an unassigned
 * booking's `[A, B, C]` scope): for any bucket number shared by two competing scopes, each
 * practitioner's own bucket-number sequence stays internally ascending in both callers' key lists
 * regardless of what other practitioners' keys are interleaved around it, which is the actual
 * property the no-livelock argument needs (identical relative order for any bucket pair BOTH
 * competitors want), not identical full key lists.
 */
export function scopedBucketKeys(
  start: number,
  end: number,
  bucketScope: readonly string[] | undefined,
  bucketSeconds = CAPACITY_BUCKET_SECONDS,
): string[] {
  const baseKeys = bucketKeysForInterval(start, end, bucketSeconds);
  if (!bucketScope || bucketScope.length === 0) return baseKeys;
  const sortedStaffIds = Array.from(new Set(bucketScope)).sort();
  const keys: string[] = [];
  for (const staffId of sortedStaffIds) {
    for (const key of baseKeys) keys.push(`p:${staffId}:${key}`);
  }
  return keys;
}
