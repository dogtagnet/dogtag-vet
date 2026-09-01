import "server-only";
import {CapacityBucket} from "@/lib/models/CapacityBucket";
import {Appointment, type AppointmentDoc, type BookingIdentity} from "@/lib/models/Appointment";
import {scopedBucketKeys} from "@/lib/booking/buckets";
import type {BookingStore} from "@/lib/booking/book";
import type {OccupiedInterval} from "@/lib/booking/types";

export interface AppointmentDraft {
  clientId?: string;
  /** Optional here (unlike `AppointmentDoc.petIds`, always an array once persisted) - a draft
   * that omits it relies on the schema's own `default: []` at `Appointment.create` time. */
  petIds?: string[];
  serviceId?: string;
  staffName?: string;
  /** WP4.7 A4 - see `AppointmentDoc.practitionerStaffId`'s own doc comment. */
  practitionerStaffId?: string;
  /** WP4.7 A4 - see `AppointmentDoc.bucketScope`'s own doc comment. Set by `createAppointment`
   * (lifecycle.ts) to exactly what it asks `bookSlot` to claim, so the persisted record and the
   * actual reservation can never drift apart. */
  bucketScope?: string[];
  startAt: number;
  endAt: number;
  notes?: string;
  source: "staff" | "public_booking" | "mobile";
  clientName: string;
  petName: string;
  cancelToken?: string;
  /** WP4.4 - only ever set for `source: "mobile"`. */
  bookingIdentity?: BookingIdentity;
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
 * back up (or pass 0/0 for an appointment with no service, e.g. an ad-hoc staff booking).
 *
 * WP4.7 A4: replays the appointment's OWN persisted `bucketScope` (never a fresh "who's bookable
 * now" lookup) via the same `scopedBucketKeys` the original claim used - see `AppointmentDoc.
 * bucketScope`'s doc comment on why recomputing the scope at release time would be wrong (the
 * practitioner roster can change between booking and cancellation). `bucketScope` absent (every
 * clinic-mode appointment, and every one from before this field existed) falls back to the exact
 * plain keys this function always used. */
export async function releaseAppointmentBuckets(
  appointment: Pick<AppointmentDoc, "startAt" | "endAt" | "bucketScope">,
  bufferBeforeMin: number,
  bufferAfterMin: number,
): Promise<void> {
  const occupied: OccupiedInterval = {
    start: appointment.startAt - bufferBeforeMin * 60,
    end: appointment.endAt + bufferAfterMin * 60,
  };
  const keys = scopedBucketKeys(occupied.start, occupied.end, appointment.bucketScope);
  for (const key of keys) {
    await mongoBookingStore.releaseBucket(key);
  }
}
