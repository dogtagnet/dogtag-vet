import {connectToDatabase} from "@/lib/db";
import {Payment, type PaymentDoc} from "@/lib/models/Payment";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";
import {toPaymentPublicStatusResponse} from "@/lib/payments/wire";
import {getServerEnv} from "@/lib/env";

/**
 * `GET /v1/payments/{id}/public?token=...` - `vet-public-api.yaml`'s `getPaymentPublicStatus`.
 * `token` is the payment-view token stamped on the invoice's shareable link (`Payment.viewToken`),
 * checked the same order as `GET /v1/booking/appointments/{id}`: missing token -> 401 before any
 * DB lookup, unknown id -> 404, mismatched token -> 401.
 *
 * Every optional response field is genuinely OMITTED (not sent as `null`) when its iff-condition
 * doesn't hold, per the schema's documented conditions: `receiptUrl` iff `receiptAvailable`
 * (itself `status === "paid"`), and `chain`/`txHash` iff a real on-chain match populated
 * `paidWith` - both absent for a `pending` payment AND for a manually-settled `paid` one, which
 * has no `paidWith` at all (see `markPaid.ts`).
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
  return jsonWithHeaders(toPaymentPublicStatusResponse(payment, baseUrl), {headers: rateLimit.headers});
}
