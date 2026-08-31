import {connectToDatabase} from "@/lib/db";
import {resolveRegistrationChallenge} from "@/lib/registration/flow";
import {mongoRegistrationStore} from "@/lib/registration/mongoStore";
import {hexToken32} from "@/lib/schemas/common";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";

/**
 * `GET /w/:token` - the wallet-registration challenge (plans/wp4.2-client-wallet-registration.md,
 * dogtag-vet section 4). Mobile-facing, non-consuming (mirrors `GET /p/:token`'s
 * `resolveMintSession` idiom exactly). `maskedClientName` only - the response never carries the
 * client's raw name, email, phone, or address; `clientHash` is an opaque commitment the device
 * signs over without being able to open (see docs/client-wallet-registration.md's trust model).
 */
export async function GET(request: Request, {params}: {params: Promise<{token: string}>}) {
  const rateLimit = enforceRateLimit(request, "wallet-registration-resolve", 30, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const {token: rawToken} = await params;
  const parsedToken = hexToken32.safeParse(rawToken);
  if (!parsedToken.success) {
    return jsonWithHeaders(errorBody("not_found", "Token unknown or malformed."), {
      status: 404,
      headers: rateLimit.headers,
    });
  }

  await connectToDatabase();
  const now = Math.floor(Date.now() / 1000);
  const result = await resolveRegistrationChallenge(mongoRegistrationStore, parsedToken.data, now);
  if (!result.ok) {
    const message = result.status === 404 ? "Token unknown or malformed." : "This registration link has expired.";
    const code = result.status === 404 ? "not_found" : "expired_or_reused";
    return jsonWithHeaders(errorBody(code, message), {status: result.status, headers: rateLimit.headers});
  }

  const {session, ttlSecs} = result;
  return jsonWithHeaders(
    {
      clinicName: session.clinicName,
      clone: session.clinic,
      chainId: session.chainId,
      maskedClientName: session.maskedClientName,
      clientHash: session.clientHash,
      registrationId: session.registrationId,
      issuedAt: session.issuedAt,
      blockNumber: session.blockNumber,
      deadline: session.deadline,
      ttlSecs,
    },
    {headers: rateLimit.headers},
  );
}
