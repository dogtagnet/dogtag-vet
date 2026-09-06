import {connectToDatabase} from "@/lib/db";
import {getDelegationSessionStatusForDevice} from "@/lib/delegation/flow";
import {mongoDelegationStore} from "@/lib/delegation/mongoStore";
import {hexToken32} from "@/lib/schemas/common";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";

/**
 * `GET /d/:token/status` - `specs/vet-public-api.yaml`'s `getDelegationSessionStatus`, add-kind
 * only (`getDelegationSessionStatusForDevice` scopes the lookup the same way `GET /d/:token`
 * does). `status` here is the PUBLIC wire vocabulary `[pending, claimed, adding, added, error]` -
 * this route is the ONE place this app's internal `"submitting"/"confirmed"` ever get translated
 * to the wire's `"adding"/"added"` (`lib/delegation/flow.ts`'s own doc comment on why the
 * translation lives here and not on the stored document).
 *
 * `bundle` (V4, `DelegationCoOwnerBundle`) is not yet attached - `readyForBundle` on the pure
 * result flags exactly when it should be, for the follow-up wave to wire in without touching this
 * route's shape.
 */
export async function GET(request: Request, {params}: {params: Promise<{token: string}>}) {
  const rateLimit = enforceRateLimit(request, "delegation-status", 60, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const {token: rawToken} = await params;
  const parsedToken = hexToken32.safeParse(rawToken);
  if (!parsedToken.success) {
    return jsonWithHeaders(errorBody("not_found", "Token unknown or malformed."), {status: 404, headers: rateLimit.headers});
  }

  await connectToDatabase();
  const now = Math.floor(Date.now() / 1000);
  const result = await getDelegationSessionStatusForDevice(mongoDelegationStore, parsedToken.data, now);
  if (!result.ok) {
    const message = result.status === 404 ? "Token unknown or malformed." : "This session is no longer available.";
    const code = result.status === 404 ? "not_found" : "expired_or_reused";
    return jsonWithHeaders(errorBody(code, message), {status: result.status, headers: rateLimit.headers});
  }

  return jsonWithHeaders(
    {
      status: result.status,
      dogTagIdField: result.dogTagIdField,
      ...(result.reason ? {reason: result.reason} : {}),
    },
    {headers: rateLimit.headers},
  );
}
