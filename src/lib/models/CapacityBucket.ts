import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";

/**
 * The atomic reservation ledger `src/lib/booking/book.ts` reserves against - one document per
 * fixed 5-minute time bucket (`CAPACITY_BUCKET_SECONDS` in `src/lib/booking/buckets.ts`) that
 * currently has at least one claim. See `bookSlot`'s doc comment for why this, rather than a
 * unique-slot-key or an insert-then-recount, is the double-booking-prevention mechanism this app
 * uses.
 */
export interface CapacityBucketDoc {
  _id: string; // the bucket key from bucketKeysForInterval
  count: number;
}

const capacityBucketSchema = new Schema<CapacityBucketDoc>({
  _id: {type: String, required: true},
  count: {type: Number, required: true, default: 0},
});

export const CapacityBucket = getOrCreateModel<CapacityBucketDoc>("CapacityBucket", capacityBucketSchema);
