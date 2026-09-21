import {connectToDatabase} from "@/lib/db";
import {Payment, type PaymentDoc} from "@/lib/models/Payment";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";
import {toPaymentPublicStatusResponse} from "@/lib/payments/wire";
import {getServerEnv} from "@/lib/env";
import {roaxChainId} from "@/lib/paymentChainRead";

/**
 * `GET /v1/payments/{id}/public?token=...` - `vet-public-api.yaml`'s `getPaymentPublicStatus`.
 * `token` is the payment-view token stamped on the invoice's shareable link (`Payment.viewToken`),
 * checked the same order as `GET /v1/booking/appointments/{id}`: missing token -> 401 before any
 * DB lookup, unknown id -> 404, mismatched token -> 401.
 *
 * Every optional response field is genuinely OMITTED (not sent as `null`) when its iff-condition
 * doesn't hold - see `toPaymentPublicStatusResponse`'s own doc comment for the full list
 * (`receiptUrl`, `chain`/`chainId`/`txHash`, `rails`, `expiresAt`) and exactly which condition
 * gates each one. WP4.18 V6 added `rails` (the fiat amount, token amount, token symbol, chain id,
 * receiving address, and EIP-681 request for every open crypto rail), `chainId` alongside the
 * pre-existing `chain` string, the always-present `confirmationsRequired`, and `expiresAt` - all
 * purely additive, so a pre-WP4.18 consumer of this endpoint keeps working unchanged. The
 * `confirmationsRequired`/`expiresAt` pair was settled after the ios and specs waves' own review
 * of this exact response shape (cross-repo wire contract ruling - vet's rails[] model won, these
 * two fields were the accepted additions on top of it).
 */
export async function GET(request: Request, {params}: {params: Promise<{id: string}>}) {
  const rateLimit = enforceRateLimit(request, "payment-public-status", 30, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return jsonWithHeaders(errorBody("unauthorized", "token is required."), {status: 401, headers: rateLimit.headers});
  }

  const {id} = await params;
  await connectToDatabase();
  const payment = await Payment.findOne({paymentId: id}).lean<PaymentDoc>();
  if (!payment) {
    return jsonWithHeaders(errorBody("not_found", "Payment not found."), {status: 404, headers: rateLimit.headers});
  }
  if (payment.viewToken !== token) {
    return jsonWithHeaders(errorBody("unauthorized", "token does not match this payment."), {
      status: 401,
      headers: rateLimit.headers,
    });
  }

  const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? new URL(request.url).origin;
  const confirmationsRequired = getServerEnv().CONFIRMATIONS_ROAX;
  return jsonWithHeaders(toPaymentPublicStatusResponse(payment, baseUrl, roaxChainId(), confirmationsRequired), {
    headers: rateLimit.headers,
  });
}
