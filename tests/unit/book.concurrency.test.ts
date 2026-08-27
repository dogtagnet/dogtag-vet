import {describe, expect, it} from "vitest";
import {bookSlot, type BookingStore} from "@/lib/booking/book";
import type {OccupiedInterval} from "@/lib/booking/types";

interface Draft {
  label: string;
}

interface Record {
  label: string;
}

/** A random short delay so operations from concurrent `bookSlot` calls genuinely interleave on
 * the event loop, rather than each call's internal awaits happening to resolve in program order
 * (which would make the race trivially "safe" without actually exercising it). */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 4)));
}

/**
 * In-memory stand-in for the mongoose-backed store: no real database, so `bookSlot`'s concurrency
 * algorithm can be exercised with genuinely concurrent calls (via `Promise.all`) in a unit test.
 *
 * `reserveBucket` models what a Mongo `findOneAndUpdate({_id, count: {$lt: capacity}}, {$inc:
 * {count: 1}})` guarantees: the network round trip to "reach the database" (`tick()`) can be
 * arbitrarily delayed and reordered relative to other concurrent calls, but the read-check-write
 * decision itself, once it starts running, executes with no `await` in between - exactly as
 * MongoDB serializes concurrent writes to a single document. Putting `tick()` *before* the
 * synchronous critical section (rather than inside it) is what makes this a faithful model rather
 * than a check-then-act race of its own.
 */
class InMemoryBookingStore implements BookingStore<Draft, Record> {
  private counts = new Map<string, number>();
  private records: Record[] = [];

  async reserveBucket(bucketKey: string, capacity: number): Promise<boolean> {
    await tick();
    const current = this.counts.get(bucketKey) ?? 0;
    if (current >= capacity) return false;
    this.counts.set(bucketKey, current + 1);
    return true;
  }

  async releaseBucket(bucketKey: string): Promise<void> {
    await tick();
    const current = this.counts.get(bucketKey) ?? 0;
    this.counts.set(bucketKey, Math.max(0, current - 1));
  }

  async insert(draft: Draft): Promise<Record> {
    await tick();
    const record: Record = {label: draft.label};
    this.records.push(record);
    return record;
  }

  survivors(): Record[] {
    return this.records;
  }
}

describe("bookSlot - concurrency", () => {
  it("lets exactly `capacity` of N concurrent requests for the identical slot win", async () => {
    for (let trial = 0; trial < 30; trial++) {
      const store = new InMemoryBookingStore();
      const occupied: OccupiedInterval = {start: 1000, end: 2000};
      const capacity = 1;
      const attempts = 5;

      const results = await Promise.all(
        Array.from({length: attempts}, (_, i) => bookSlot(store, {label: `req-${i}`}, {occupied, capacity})),
      );

      const wins = results.filter((r) => r.ok);
      const losses = results.filter((r) => !r.ok);
      expect(wins).toHaveLength(capacity);
      expect(losses).toHaveLength(attempts - capacity);
      expect(losses.every((r) => !r.ok && r.reason === "slot_conflict")).toBe(true);
      expect(store.survivors()).toHaveLength(capacity);
    }
  });

  it("lets exactly `capacity` of N concurrent requests win when capacity is greater than one", async () => {
    for (let trial = 0; trial < 30; trial++) {
      const store = new InMemoryBookingStore();
      const occupied: OccupiedInterval = {start: 1000, end: 2000};
      const capacity = 2;
      const attempts = 6;

      const results = await Promise.all(
        Array.from({length: attempts}, (_, i) => bookSlot(store, {label: `req-${i}`}, {occupied, capacity})),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(capacity);
      expect(store.survivors()).toHaveLength(capacity);
    }
  });

  it("shares capacity across overlapping-but-different start times, not just identical ones", async () => {
    // Regression: a unique-slot-key reservation would only serialize bookings at the exact same
    // startAt. These three requests target different (but mutually overlapping, once buffered)
    // occupied intervals sharing one clinic-wide capacity of 1 - only one may win.
    for (let trial = 0; trial < 30; trial++) {
      const store = new InMemoryBookingStore();
      const capacity = 1;
      const intervals: OccupiedInterval[] = [
        {start: 1000, end: 2000},
        {start: 1500, end: 2500}, // overlaps the first
        {start: 1900, end: 2900}, // overlaps both
      ];

      const results = await Promise.all(
        intervals.map((occupied, i) => bookSlot(store, {label: `req-${i}`}, {occupied, capacity})),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(store.survivors()).toHaveLength(1);
    }
  });

  it("does not let a booking for a genuinely separate slot consume the same capacity", async () => {
    const store = new InMemoryBookingStore();
    const capacity = 1;
    const a: OccupiedInterval = {start: 1000, end: 2000};
    const b: OccupiedInterval = {start: 50_000, end: 51_000}; // far enough apart to share no bucket

    const [resultA, resultB] = await Promise.all([
      bookSlot(store, {label: "a"}, {occupied: a, capacity}),
      bookSlot(store, {label: "b"}, {occupied: b, capacity}),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    expect(store.survivors()).toHaveLength(2);
  });

  it("keeps the first booking on conflict when requests are strictly sequential", async () => {
    const store = new InMemoryBookingStore();
    const occupied: OccupiedInterval = {start: 1000, end: 2000};
    const first = await bookSlot(store, {label: "first"}, {occupied, capacity: 1});
    const second = await bookSlot(store, {label: "second"}, {occupied, capacity: 1});

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    const survivors = store.survivors();
    expect(survivors).toHaveLength(1);
    expect(survivors.at(0)?.label).toBe("first");
  });

  it("releases every already-claimed bucket when a later bucket in the same attempt is full", async () => {
    // A long appointment spans multiple 5-minute buckets; if the LAST bucket is already full,
    // the earlier ones this attempt claimed must be released, not leaked.
    const store = new InMemoryBookingStore();
    const capacity = 1;
    const blocker: OccupiedInterval = {start: 900, end: 1000}; // occupies only the last bucket
    const long: OccupiedInterval = {start: 0, end: 1000}; // spans several buckets, including the last

    const blockerResult = await bookSlot(store, {label: "blocker"}, {occupied: blocker, capacity});
    expect(blockerResult.ok).toBe(true);

    const longResult = await bookSlot(store, {label: "long"}, {occupied: long, capacity});
    expect(longResult.ok).toBe(false);

    // The earlier buckets `long` claimed before failing must now be free for a fresh booking.
    const retry: OccupiedInterval = {start: 0, end: 300};
    const retryResult = await bookSlot(store, {label: "retry"}, {occupied: retry, capacity});
    expect(retryResult.ok).toBe(true);
  });
});
