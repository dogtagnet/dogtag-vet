import {connectToDatabase} from "@/lib/db";
import {resolveMintSession} from "@/lib/mint/flow";
import {mongoMintStore} from "@/lib/mint/mongoStore";
import {toWireWeightEntry} from "@/lib/mint/wire";
import {hexToken32} from "@/lib/schemas/common";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";

/**
 * `GET /p/:token` - `resolveMintSession` in `vet-public-api.yaml`. Mobile-facing, v1-compatible,
 * non-consuming (see `lib/mint/flow.ts`'s `resolveMintSession` for the TTL-extension mechanics).
 * A malformed token is documented as "unknown or malformed" -> 404, so a zod shape failure is
 * folded into the same 404 as a genuinely-unknown token rather than becoming a 400 this route
 * never documents.
 */
export async function GET(request: Request, {params}: {params: Promise<{token: string}>}) {
  const rateLimit = enforceRateLimit(request, "mint-resolve", 30, 60_000);
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
  const result = await resolveMintSession(mongoMintStore, parsedToken.data, now);
  if (!result.ok) {
    const message = result.status === 404 ? "Token unknown or malformed." : "This session has expired.";
    const code = result.status === 404 ? "token_not_found" : "token_expired";
    return jsonWithHeaders(errorBody(code, message), {status: result.status, headers: rateLimit.headers});
  }

  const {session, ttlSecs} = result;
  return jsonWithHeaders(
    {
      sessionId: session.sessionId,
      dogTagId: session.dogTagIdDec,
      status: session.status,
      pet: {
        name: session.petName,
        profile: {
          species: session.profile.species,
          breedVbo: session.profile.breedVbo,
          breedLabel: session.profile.breedLabel,
          sex: session.profile.sex,
          neuterStatus: session.profile.neuterStatus,
          dateOfBirth: session.profile.dateOfBirth,
          weightHistory: session.profile.weightHistory.map(toWireWeightEntry),
        },
        microchip: {
          code: session.microchip.code,
          standard: session.microchip.standard,
          implantDate: session.microchip.implantDate,
          bodyLocation: session.microchip.bodyLocation,
        },
      },
      ownerIdentity: session.ownerIdentity,
      identityLeaves: session.identityLeaves,
      // No owner-supplied-but-unattested claims exist in this deployment's data model (every field
      // the vet enters is vet-attested) - required by the schema, so always emitted as `{}` rather
      // than omitted.
      unverifiedClaims: {},
      ttlSecs,
    },
    {headers: rateLimit.headers},
  );
}
