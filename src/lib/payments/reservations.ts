import "server-only";
import {AmountReservation} from "@/lib/models/AmountReservation";
import type {PaymentChainKey} from "@/lib/chains";
import type {PaymentToken} from "@/lib/models/Payment";

export function reservationKey(
  chainKey: PaymentChainKey,
  token: PaymentToken,
  receivingAddress: string,
  amountBase: string,
): string {
  return `${chainKey}:${token}:${receivingAddress.toLowerCase()}:${amountBase}`;
}

/** `pickDust`'s `tryReserve` callback, backed by `AmountReservation`'s unique-`_id` insert. Returns
 * `false` (never throws) on a duplicate-key race, which is the ordinary "someone else already has
 * this dust value" outcome `pickDust` retries past. */
export function makeTryReserve(
  paymentId: string,
  chainKey: PaymentChainKey,
  token: PaymentToken,
  receivingAddress: string,
): (amountBase: string) => Promise<boolean> {
  return async (amountBase: string) => {
    try {
      await AmountReservation.create({_id: reservationKey(chainKey, token, receivingAddress, amountBase), paymentId});
      return true;
    } catch (err) {
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
  };
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as {code?: number}).code === 11000;
}

/** Releases every reservation held by `paymentId` - call once a payment leaves `pending`
 * (paid, cancelled, or swept as expired) so its dust values become available to new invoices. */
export async function releaseReservationsForPayment(paymentId: string): Promise<void> {
  await AmountReservation.deleteMany({paymentId});
}
