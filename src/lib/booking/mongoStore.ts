import "server-only";
import {CapacityBucket} from "@/lib/models/CapacityBucket";
import {Appointment, type AppointmentDoc} from "@/lib/models/Appointment";
import {bucketKeysForInterval} from "@/lib/booking/buckets";
import type {BookingStore} from "@/lib/booking/book";
import type {OccupiedInterval} from "@/lib/booking/types";

export interface AppointmentDraft {
  clientId?: string;
  /** Optional here (unlike `AppointmentDoc.petIds`, always an array once persisted) - a draft
   * that omits it relies on the schema's own `default: []` at `Appointment.create` time. */
  petIds?: string[];
  serviceId?: string;
  staffName?: string;
  startAt: number;
  endAt: number;
  notes?: string;
  source: "staff" | "public_booking" | "mobile";
  clientName: string;
  petName: string;
  cancelToken?: string;
}

/**
 * Mongoose-backed `BookingStore` (see `book.ts` for the algorithm and why it's structured this
 * way). `reserveBucket` does one unconditional atomic increment - `findOneAndUpdate` with
 * `{upsert: true}` - rather than a conditional `{count: {$lt: capacity}}` filter: MongoDB
 * transparently retries an upsert that races a concurrent insert of the same `_id` (server-side,
 * since 3.2), so every concurrent claimant is guaranteed to receive a distinct, correctly-ordered
 * resulting count with a single write, and only overshoots (`count > capacity`) pay for a second,
 * compensating write to back it out.
 */
export const mongoBookingStore: BookingStore<AppointmentDraft, AppointmentDoc> = {
  async reserveBucket(bucketKey: string, capacity: number): Promise<boolean> {
    const updated = await CapacityBucket.findOneAndUpdate(
      {_id: bucketKey},
      {$inc: {count: 1}},
      {upsert: true, new: true},
    ).lean<{count: number}>();
    if (!updated) throw new Error(`Failed to reserve capacity bucket ${bucketKey}`);
    if (updated.count > capacity) {
      await CapacityBucket.updateOne({_id: bucketKey}, {$inc: {count: -1}});
      return false;
    }
    return true;
  },

  async releaseBucket(bucketKey: string): Promise<void> {
    await CapacityBucket.updateOne({_id: bucketKey}, {$inc: {count: -1}});
  },

  async insert(draft: AppointmentDraft): Promise<AppointmentDoc> {
    const created = await Appointment.create({...draft, status: "scheduled"});
    return created.toObject();
  },
};

/** Releases the capacity this appointment's occupied (buffered) interval holds - call this
 * whenever a booked appointment is cancelled, so the slot becomes available again. `bufferBeforeMin`
 * /`bufferAfterMin` are the service's buffers *at cancellation time*; buffers are not stored on
 * the appointment itself (see wp4-vet.md's Appointment shape), so callers must look the service
 * back up (or pass 0/0 for an appointment with no service, e.g. an ad-hoc staff booking). */
export async function releaseAppointmentBuckets(
  appointment: Pick<AppointmentDoc, "startAt" | "endAt">,
  bufferBeforeMin: number,
  bufferAfterMin: number,
): Promise<void> {
  const occupied: OccupiedInterval = {
    start: appointment.startAt - bufferBeforeMin * 60,
    end: appointment.endAt + bufferAfterMin * 60,
  };
  const keys = bucketKeysForInterval(occupied.start, occupied.end);
  for (const key of keys) {
    await mongoBookingStore.releaseBucket(key);
  }
}
