import {connectToDatabase} from "@/lib/db";
import {RecordVerifySession, type RecordVerifySessionDoc} from "@/lib/models/RecordVerifySession";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {hexToken32} from "@/lib/schemas/common";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";

/**
 * `GET /v/:token` - plan section 11.2 V6's "Records mode" ceremony, non-consuming resolve step
 * (mirrors `GET /w/:token`/`GET /i/:token`'s own shape, NOT `GET /e/:token`'s one-shot pattern -
 * unlike an export, this ceremony has something for the phone to submit back, so it needs a
 * separate `POST .../complete`, exactly the same structural reason those two ceremonies split the
 * same way). Safe to retry - the owner's device is expected to show a consent-style screen (clinic
 * name, purpose) before choosing which of its own records to present, exactly like `GET /w/:token`'s
 * own doc comment describes for wallet registration's consent screen.
 */
export async function GET(request: Request, {params}: {params: Promise<{token: string}>}) {
  const rateLimit = enforceRateLimit(request, "record-verify-resolve", 30, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const {token: rawToken} = await params;
  const parsedToken = hexToken32.safeParse(rawToken);
  if (!parsedToken.success) {
    return jsonWithHeaders(errorBody("not_found", "Token unknown or malformed."), {status: 404, headers: rateLimit.headers});
  }

  await connectToDatabase();
  const session = await RecordVerifySession.findOne({token: parsedToken.data}).lean<RecordVerifySessionDoc>();
  if (!session) {
    return jsonWithHeaders(errorBody("not_found", "Token unknown or malformed."), {status: 404, headers: rateLimit.headers});
  }

  const now = Math.floor(Date.now() / 1000);
  // Qualified on `status === "pending"` for the identical reason `/x/:token`'s own doc comment
  // states: once a record has been presented, this same route is also a legitimate poll target, and
  // an expired deadline must not blank out a response for a submission that already went through.
  if (now > session.exp && session.status === "pending") {
    return jsonWithHeaders(errorBody("expired_or_reused", "This verification request has expired."), {status: 410, headers: rateLimit.headers});
  }

  const settings = await getClinicSettings();
  return jsonWithHeaders(
    {
      purpose: session.purpose,
      clinicName: settings.businessProfile?.name?.trim() || "",
      status: session.status,
      ttlSecs: Math.max(0, session.exp - now),
    },
    {headers: rateLimit.headers},
  );
}
