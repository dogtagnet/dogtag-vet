import {connectToDatabase} from "@/lib/db";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {resolveDelegationChallenge} from "@/lib/delegation/flow";
import {mongoDelegationStore} from "@/lib/delegation/mongoStore";
import {hexToken32} from "@/lib/schemas/common";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";

/**
 * `GET /d/:token` - the delegation-session challenge (`docs/DELEGATION.md` section 4.3 step 2;
 * `specs/vet-public-api.yaml`'s `resolveDelegationSession`). Mobile-facing, non-consuming, add-kind
 * ONLY (`resolveDelegationChallenge` scopes the lookup to `kind: "add"` - a `kind: "revoke"`
 * session's token can never resolve here, mirroring `GET /w/:token`'s own idiom).
 *
 * `petName` is read LIVE here (never snapshotted onto the session - `specs/vet-public-api.yaml`'s
 * own field doc: "the pet's current display name at this clinic - read live, not snapshotted at
 * session creation"), unlike every other field on this response, which comes straight off the
 * session's own creation-time snapshot.
 */
export async function GET(request: Request, {params}: {params: Promise<{token: string}>}) {
  const rateLimit = enforceRateLimit(request, "delegation-resolve", 30, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const {token: rawToken} = await params;
  const parsedToken = hexToken32.safeParse(rawToken);
  if (!parsedToken.success) {
    return jsonWithHeaders(errorBody("not_found", "Token unknown or malformed."), {status: 404, headers: rateLimit.headers});
  }

  await connectToDatabase();
  const now = Math.floor(Date.now() / 1000);
  const result = await resolveDelegationChallenge(mongoDelegationStore, parsedToken.data, now);
  if (!result.ok) {
    const message = result.status === 404 ? "Token unknown or malformed." : "This delegation link has expired or was already used.";
    const code = result.status === 404 ? "not_found" : "expired_or_reused";
    return jsonWithHeaders(errorBody(code, message), {status: result.status, headers: rateLimit.headers});
  }

  const {session, ttlSecs} = result;
  const pet = await Pet.findOne({petId: session.petId}).select("name").lean<Pick<PetDoc, "name">>();

  return jsonWithHeaders(
    {
      clinicName: session.clinicName,
      clone: session.clinic,
      chainId: session.chainId,
      dogTagIdField: session.dogTagIdField,
      petName: pet?.name ?? "",
      maskedTargetName: session.maskedTargetName,
      registrationId: session.registrationId,
      issuedAt: session.issuedAt,
      blockNumber: session.blockNumber,
      deadline: session.deadline,
      ttlSecs,
    },
    {headers: rateLimit.headers},
  );
}
