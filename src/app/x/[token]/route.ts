import {connectToDatabase} from "@/lib/db";
import {VerifySession, type VerifySessionDoc} from "@/lib/models/VerifySession";
import {hexToken32} from "@/lib/schemas/common";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";

/**
 * `GET /x/:token` - `resolveVerifySession` in `vet-public-api.yaml`. Mobile-facing,
 * non-consuming: proof submission (`POST /v1/verify/consent`) is the action that eventually
 * spends the nullifier, not this resolve call.
 *
 * `status` is included alongside the yaml's required fields (never in place of them) so the
 * owner's app can poll this same endpoint through `proof_received` -> `recorded`
 * (wp4-vet.md's verify flow step: "phone polls ... status") without this repo inventing a second,
 * wire-incompatible path the spec never documents - the schema has no `additionalProperties:
 * false`, so an extra field here is additive, not a departure from the contract.
 */
export async function GET(request: Request, {params}: {params: Promise<{token: string}>}) {
  const rateLimit = enforceRateLimit(request, "verify-resolve", 30, 60_000);
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
  const session = await VerifySession.findOne({token: parsedToken.data}).lean<VerifySessionDoc>();
  if (!session) {
    return jsonWithHeaders(errorBody("token_not_found", "Token unknown or malformed."), {
      status: 404,
      headers: rateLimit.headers,
    });
  }

  const now = Math.floor(Date.now() / 1000);
  // Deliberately qualified on `status === "pending"`: once a proof has been received or recorded,
  // this same route is also the phone's poll target (see the `status` field below), and a
  // deadline that has since passed must not blank out the poll response for a submission that
  // already succeeded or is already in flight.
  if (now > session.challenge.deadline && session.status === "pending") {
    return jsonWithHeaders(errorBody("token_expired", "This verification request has expired."), {
      status: 410,
      headers: rateLimit.headers,
    });
  }

  return jsonWithHeaders(
    {
      sessionId: session.sessionId,
      relayer: session.relayerAddress,
      purpose: session.purpose,
      recordType: session.recordType,
      challenge: session.challenge,
      unverifiedClaims: {},
      status: session.status,
    },
    {headers: rateLimit.headers},
  );
}
