import {bucketKeysForInterval, scopedBucketKeys} from "@/lib/booking/buckets";
import type {OccupiedInterval} from "@/lib/booking/types";

/**
 * The persistence operations `bookSlot` needs, injected so the concurrency algorithm can be unit
 * tested against an in-memory fake (no real database, no ability to actually run two requests in
 * parallel in a single-threaded test) while the production adapter backs it with mongoose.
 */
export interface BookingStore<TDraft, TRecord> {
  /**
   * Atomically try to claim one unit of capacity in `bucketKey`, which holds at most `capacity`
   * concurrent claims: increments and returns `true` if the bucket's current count is below
   * `capacity`, otherwise leaves it untouched and returns `false`. Must be a single atomic
   * read-check-write as far as any other concurrent caller can observe (a Mongo
   * `findOneAndUpdate` naturally provides this; see the adapter in the booking API route).
   */
  reserveBucket(bucketKey: string, capacity: number): Promise<boolean>;
  /** Undo one successful `reserveBucket` call on `bucketKey` (decrement). */
  releaseBucket(bucketKey: string): Promise<void>;
  /** Persist the draft appointment once every bucket its occupied interval spans has been
   * reserved. */
  insert(draft: TDraft): Promise<TRecord>;
}

export interface BookSlotParams {
  occupied: OccupiedInterval;
  capacity: number;
  /** WP4.7 A4: practitioner-mode bucket scoping (`scopedBucketKeys`) - a list of staffIds whose
   * OWN `p:<staffId>:` bucket space this claim occupies (one entry for a named/auto-assigned
   * practitioner, several for an unassigned appointment that must block every currently bookable
   * practitioner per D3). Absent or empty = today's exact clinic-mode plain bucket keys. This MUST
   * be persisted on the created record (the mongoose adapter's `insert` is where `AppointmentDraft.
   * bucketScope` actually lands) so a later cancellation's `releaseAppointmentBuckets` can replay
   * the IDENTICAL key set - recomputing "which practitioners are bookable now" at release time
   * would be wrong if the roster changed in between. */
  bucketScope?: string[];
}

export type BookSlotResult<TRecord> = {ok: true; record: TRecord} | {ok: false; reason: "slot_conflict"};

/**
 * Double-booking prevention, safe against two requests racing the same (or overlapping) slot -
 * WITHOUT a multi-document transaction (this app targets a standalone mongod for the one-pager
 * quickstart deployment, where `session.withTransaction` is unavailable) and WITHOUT any timing
 * assumption about how quickly a competing request's write becomes visible.
 *
 * Mechanism: the candidate's occupied (buffered) interval is divided into small, fixed,
 * globally-aligned time buckets (`buckets.ts`). Each bucket independently tracks how many
 * appointments currently claim it, capped at the slot's capacity, via a single atomic
 * increment-if-under-capacity operation per bucket (a Mongo `findOneAndUpdate` with a `{count:
 * {$lt: capacity}}` filter is exactly this - MongoDB serializes all writes to one document, so
 * two concurrent attempts on the same bucket can never both observe "room" and both succeed).
 * Buckets are acquired in ascending key order and, if any bucket in the set is already full, every
 * bucket already claimed by this attempt is released before returning `slot_conflict` - ordering
 * matters here: two requests whose occupied intervals share more than one bucket both try the
 * same first bucket before ever touching the second, so at most one of them proceeds past it,
 * which rules out the "each holds one bucket the other needs" livelock that unordered acquisition
 * would allow.
 *
 * This was chosen over the two alternatives the spec allows:
 * - A **unique slot-key reservation** only serializes bookings at the exact same `startAt` - two
 *   appointments at different start times can still have overlapping *occupied* (buffered)
 *   intervals and must be capacity-checked together, which a single reservation key can't express.
 * - **Insert-then-recount-and-rollback** (re-read the overlapping non-cancelled count after
 *   inserting, delete-and-409 if it exceeds capacity) reads as simpler, but was tried first here
 *   and failed its own concurrency test: ranking by an order assigned in a round trip *before*
 *   the insert (however that order is derived - an atomic counter, an ObjectId, a timestamp) can
 *   diverge from which insert actually lands first, so a later-arriving request can see an
 *   incomplete snapshot, decide it is within capacity, and return success *before* an
 *   earlier-ordered request's insert lands - oversubscribing the slot. Nothing after that point
 *   ever revisits the decision. Per-bucket atomic increments have no such window: the decision for
 *   a given bucket is made by MongoDB as one indivisible operation, not by a client racing a
 *   snapshot it read moments earlier.
 *
 * On successful cancellation, the caller must release the same bucket set (recomputed from the
 * appointment's stored `startAt`/`endAt` and its service's buffers) so the capacity becomes
 * available again - see `releaseAppointmentBuckets` in the mongoose adapter.
 */
export async function bookSlot<TDraft, TRecord>(
  store: BookingStore<TDraft, TRecord>,
  draft: TDraft,
  params: BookSlotParams,
): Promise<BookSlotResult<TRecord>> {
  const bucketKeys = scopedBucketKeys(params.occupied.start, params.occupied.end, params.bucketScope);
  const claim = await claimBucketSet(store, bucketKeys, params.capacity);
  if (!claim.ok) return {ok: false, reason: "slot_conflict"};

  try {
    const record = await store.insert(draft);
    return {ok: true, record};
  } catch (err) {
    await releaseAll(store, claim.claimedKeys);
    throw err;
  }
}

export type ClaimBucketSetResult = {ok: true; claimedKeys: string[]} | {ok: false};

/**
 * The ordered-claim-with-rollback loop at the heart of `bookSlot` above, extracted so WP4.7 A6's
 * practitioner reassignment (`lifecycle.ts`'s `reassignPractitioner`) can reuse the identical
 * correctness properties - ascending key order (the anti-livelock property `bookSlot`'s own doc
 * comment explains) and rolling back only what THIS attempt itself claimed - rather than
 * duplicating this loop and risking the two copies drifting apart. Reassignment claims a bucket set
 * for an ALREADY-EXISTING appointment (an update, not `store.insert`), which is the only reason
 * this isn't simply `bookSlot` itself.
 */
export async function claimBucketSet<TDraft, TRecord>(
  store: BookingStore<TDraft, TRecord>,
  keys: string[],
  capacity: number,
): Promise<ClaimBucketSetResult> {
  const claimed: string[] = [];
  for (const key of keys) {
    const acquired = await store.reserveBucket(key, capacity);
    if (!acquired) {
      await releaseAll(store, claimed);
      return {ok: false};
    }
    claimed.push(key);
  }
  return {ok: true, claimedKeys: claimed};
}

export async function releaseAll<TDraft, TRecord>(store: BookingStore<TDraft, TRecord>, keys: string[]): Promise<void> {
  for (const key of keys) await store.releaseBucket(key);
}

export {bucketKeysForInterval};
