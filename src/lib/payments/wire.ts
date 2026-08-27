import type {PaymentDoc} from "@/lib/models/Payment";
import {chainKeyToWireChain} from "@/lib/payments/wireChain";

export interface PaymentPublicStatusResponse {
  status: PaymentDoc["status"];
  amount: {amount: string; currency: string};
  receiptAvailable: boolean;
  receiptUrl?: string;
  chain?: string;
  txHash?: string;
}

/**
 * Pure builder for `vet-public-api.yaml`'s `PaymentPublicStatusResponse`, extracted out of the
 * route handler specifically so its iff-conditions are directly unit-testable
 * (`tests/unit/wire.test.ts`) rather than only "read against the yaml by eye":
 *
 * - `receiptAvailable` iff `status === "paid"`.
 * - `receiptUrl` present iff `receiptAvailable` - genuinely OMITTED otherwise, never `null`.
 * - `chain`/`txHash` present iff a real on-chain match populated `paidWith` - both absent for a
 *   `pending` payment AND for a manually-settled `paid` one (no `paidWith` at all; see
 *   `markPaid.ts`), never just set to `undefined` on the object (an explicit `undefined` key can
 *   still round-trip through some JSON paths as `null` or an empty key - building the object
 *   conditionally with spreads, as below, is what actually guarantees the key is absent from the
 *   serialized response).
 */
export function toPaymentPublicStatusResponse(payment: PaymentDoc, baseUrl: string): PaymentPublicStatusResponse {
  const receiptAvailable = payment.status === "paid";
  return {
    status: payment.status,
    amount: {amount: payment.total, currency: payment.currency},
    receiptAvailable,
    ...(receiptAvailable ? {receiptUrl: `${baseUrl.replace(/\/$/, "")}/r/pay/${payment.receiptToken}`} : {}),
    ...(payment.paidWith
      ? {chain: chainKeyToWireChain(payment.paidWith.chainKey), txHash: payment.paidWith.txHash}
      : {}),
  };
}
