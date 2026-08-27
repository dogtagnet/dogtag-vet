import {connectToDatabase} from "@/lib/db";
import {getMintSessionStatus} from "@/lib/mint/flow";
import {mongoMintStore} from "@/lib/mint/mongoStore";
import {deviceSafeReason} from "@/lib/mint/wire";
import {hexToken32} from "@/lib/schemas/common";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";

/**
 * `GET /p/:token/status` - `getMintSessionStatus` in `vet-public-api.yaml`. `reason` is a
 * device-safe sentence derived from `errorStage` ONLY (`deviceSafeReason`) - never the session
 * row, never operator error text.
 */
export async function GET(request: Request, {params}: {params: Promise<{token: string}>}) {
  const rateLimit = enforceRateLimit(request, "mint-status", 60, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const {token: rawToken} = await params;
  const parsedToken = hexToken32.safeParse(rawToken);
  if (!parsedToken.success) {
    return jsonWithHeaders(errorBody("token_not_found", "Token unknown or malformed."), {
      status: 404,
      headers: rateLimit.headers,
    });
  }

  await connectToDatabase();
  const now = Math.floor(Date.now() / 1000);
  const result = await getMintSessionStatus(mongoMintStore, parsedToken.data, now);
  if (!result.ok) {
    const message = result.status === 404 ? "Token unknown or malformed." : "This session is no longer available.";
    const code = result.status === 404 ? "token_not_found" : "token_expired";
    return jsonWithHeaders(errorBody(code, message), {status: result.status, headers: rateLimit.headers});
  }

  const reason = deviceSafeReason(result.errorStage);
  return jsonWithHeaders(
    {
      status: result.status,
      dogTagId: result.dogTagIdDec,
      ...(reason ? {reason} : {}),
    },
    {headers: rateLimit.headers},
  );
}
