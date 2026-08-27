import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";

/**
 * The atomic reservation ledger `src/lib/payments/amountBase.ts`'s `pickDust` claims against - one
 * document per currently-open `(chainKey, token, receivingAddress, amountBase)` tuple, exactly
 * mirroring `CapacityBucket.ts`'s "unique `_id` insert = atomic claim" shape for booking capacity.
 *
 * A plain read-then-write ("query open payments for this rail, pick an unused dust value, write
 * the payment") is racy: two payment-creation requests hitting the same rail concurrently can both
 * read the same "unused" set and pick the same dust value before either has written anything back.
 * Mongo's unique index on `_id` closes that window the same way `CapacityBucket.count`'s atomic
 * increment does for booking - `Payment.create` on a duplicate `_id` throws (E11006), which
 * `pickDust`'s `tryReserve` callback below turns into "try the next dust value" rather than a hard
 * failure.
 *
 * Released (deleted) whenever the owning payment leaves the `pending` state (paid, cancelled, or
 * swept as expired) - see `src/lib/payments/reservations.ts`.
 */
export interface AmountReservationDoc {
  _id: string; // `${chainKey}:${token}:${receivingAddress.toLowerCase()}:${amountBase}`
  paymentId: string;
}

const amountReservationSchema = new Schema<AmountReservationDoc>({
  _id: {type: String, required: true},
  paymentId: {type: String, required: true, index: true},
});

export const AmountReservation = getOrCreateModel<AmountReservationDoc>(
  "AmountReservation",
  amountReservationSchema,
);
