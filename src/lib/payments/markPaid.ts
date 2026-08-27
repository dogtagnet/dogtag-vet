import "server-only";
import {Payment, type PaidWith, type PaymentDoc} from "@/lib/models/Payment";
import {releaseReservationsForPayment} from "@/lib/payments/reservations";

/**
 * The two ways a `pending` payment becomes `paid` - an on-chain match (`paidWith` populated with a
 * real txHash/from/blockNumber, all `required` on that subschema) or a manual staff action
 * (`manualPaidNote` set instead). The two fields never coexist: a manual mark-paid does NOT
 * synthesize a placeholder `paidWith` (empty strings would either fail the subschema's `required`
 * validators or - worse - pass validation and then read back to the public endpoint and the
 * receipt PDF as if a real transaction had been observed). `PaymentPublicStatusResponse`'s
 * `chain`/`txHash` are both optional for exactly this reason: "Absent while `status == pending`" is
 * the yaml's only documented omission case, but nothing in the schema requires them once `paid`
 * either, so a manually-settled invoice reporting neither is a conforming response.
 */
export async function markPaymentPaidFromChain(paymentId: string, paidWith: PaidWith): Promise<PaymentDoc | null> {
  const updated = await Payment.findOneAndUpdate(
    {paymentId, status: "pending"},
    {$set: {status: "paid", paidWith}},
    {new: true},
  ).lean<PaymentDoc>();
  if (updated) await releaseReservationsForPayment(paymentId);
  return updated;
}

export async function markPaymentPaidManually(paymentId: string, note: string): Promise<PaymentDoc | null> {
  const updated = await Payment.findOneAndUpdate(
    {paymentId, status: "pending"},
    {$set: {status: "paid", manualPaidNote: note}},
    {new: true},
  ).lean<PaymentDoc>();
  if (updated) await releaseReservationsForPayment(paymentId);
  return updated;
}

export async function cancelPayment(paymentId: string): Promise<PaymentDoc | null> {
  const updated = await Payment.findOneAndUpdate(
    {paymentId, status: "pending"},
    {$set: {status: "cancelled"}},
    {new: true},
  ).lean<PaymentDoc>();
  if (updated) await releaseReservationsForPayment(paymentId);
  return updated;
}

/** Expiry sweep (worker): any `pending` payment past its `dueAt` is marked `expired` and its dust
 * reservations released, so a new invoice can reuse that (chain, token, address, amountBase). A
 * payment with no `dueAt` never expires on its own - it stays `pending` until staff cancels or
 * marks it paid. */
export async function sweepExpiredPayments(now: number): Promise<number> {
  const expired = await Payment.find({status: "pending", dueAt: {$lt: now}}).select("paymentId").lean<PaymentDoc[]>();
  for (const payment of expired) {
    await Payment.updateOne({paymentId: payment.paymentId}, {$set: {status: "expired"}});
    await releaseReservationsForPayment(payment.paymentId);
  }
  return expired.length;
}
