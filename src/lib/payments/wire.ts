import type {PaymentDoc, PaymentToken} from "@/lib/models/Payment";
import {chainKeyToWireChain} from "@/lib/payments/wireChain";
import {formatTokenAmount} from "@/lib/format";

/** One open crypto rail as the phone (or any other public consumer) needs to pay it - WP4.18 V6:
 * "the fiat amount, the token amount, the token symbol, the chain id, the receiving address, the
 * EIP-681 request and the status" (the fiat amount and status are the RESPONSE's own top-level
 * `amount`/`status`, shared across every rail on one payment; everything else is per rail, because
 * ROAX-only still means one payment can offer BOTH a PLASMA and a RUSD rail at once - see
 * `Payment.crypto`, an array). */
export interface PaymentPublicRail {
  tokenSymbol: PaymentToken;
  /** Exact human-readable decimal amount, dust suffix included - the same value
   * `formatTokenAmount` produces for the QR caption (`PaymentRailTabs.tsx`), never rounded, since
   * an amount rounded away would ask the payer to send something the watcher can't match. */
  tokenAmount: string;
  chainId: number;
  receivingAddress: string;
  eip681: string;
}

export interface PaymentPublicStatusResponse {
  status: PaymentDoc["status"];
  amount: {amount: string; currency: string};
  receiptAvailable: boolean;
  receiptUrl?: string;
  chain?: string;
  chainId?: number;
  txHash?: string;
  rails?: PaymentPublicRail[];
}

/**
 * Pure builder for `vet-public-api.yaml`'s `PaymentPublicStatusResponse`, extracted out of the
 * route handler specifically so its iff-conditions are directly unit-testable
 * (`tests/unit/wire.test.ts`) rather than only "read against the yaml by eye". `chainId` is a
 * parameter (never re-derived here) for the same reason `tokenRegistry.ts`'s `tokenInfo` takes one
 * - this module stays free of `server-only`/env reads, and the caller (the route handler) is the
 * one place that already validates it via `paymentChainRead.ts`'s `roaxChainId()`.
 *
 * - `receiptAvailable` iff `status === "paid"`.
 * - `receiptUrl` present iff `receiptAvailable` - genuinely OMITTED otherwise, never `null`.
 * - `chain`/`chainId`/`txHash` present iff a real on-chain match populated `paidWith` - both
 *   absent for a `pending` payment AND for a manually-settled `paid` one (no `paidWith` at all;
 *   see `markPaid.ts`). ADDITIVE as of WP4.18: `chain` (the kebab-case wire string, unchanged) and
 *   `txHash` are the pre-existing fields with their exact pre-existing iff-condition; `chainId`
 *   (the numeric form) is new, alongside `chain`, never replacing it - a pre-WP4.18 consumer that
 *   only reads `chain`/`txHash` keeps working unchanged.
 * - `rails` present iff `status === "pending"` AND at least one crypto rail exists - once a
 *   payment is settled (paid, or terminally cancelled/expired), there is nothing left to pay, so
 *   this is omitted rather than describing rails that no longer mean anything; mirrors the
 *   pre-existing `!paid && payment.crypto.length > 0` gate `pay/[id]/page.tsx` already uses to
 *   show `PaymentRailTabs`. Every field in each entry is genuinely OMITTED (never set to
 *   `undefined`) when its iff-condition doesn't hold - built with conditional spreads throughout,
 *   never a plain object literal with optional keys, so a JSON round trip can never turn an absent
 *   key into an explicit `null`.
 */
export function toPaymentPublicStatusResponse(payment: PaymentDoc, baseUrl: string, chainId: number): PaymentPublicStatusResponse {
  const receiptAvailable = payment.status === "paid";
  return {
    status: payment.status,
    amount: {amount: payment.total, currency: payment.currency},
    receiptAvailable,
    ...(receiptAvailable ? {receiptUrl: `${baseUrl.replace(/\/$/, "")}/r/pay/${payment.receiptToken}`} : {}),
    ...(payment.paidWith
      ? {chain: chainKeyToWireChain(payment.paidWith.chainKey), chainId, txHash: payment.paidWith.txHash}
      : {}),
    ...(payment.status === "pending" && payment.crypto.length > 0
      ? {
          rails: payment.crypto.map(
            (rail): PaymentPublicRail => ({
              tokenSymbol: rail.token,
              tokenAmount: formatTokenAmount(rail.amountBase, rail.decimals),
              chainId,
              receivingAddress: rail.receivingAddress,
              eip681: rail.eip681,
            }),
          ),
        }
      : {}),
  };
}
