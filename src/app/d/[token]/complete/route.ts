import {connectToDatabase} from "@/lib/db";
import {completeDelegationClaim} from "@/lib/delegation/flow";
import {mongoDelegationStore} from "@/lib/delegation/mongoStore";
import {isRegisteredWalletForClient} from "@/lib/delegation/clientWallet";
import {readIsSecondary} from "@/lib/chainRead";
import {hexToken32} from "@/lib/schemas/common";
import {completeDelegationSchema} from "@/lib/schemas/delegation";
import {enforceRateLimit, errorBody, jsonWithHeaders, readJsonBody} from "@/lib/publicApi";
import {requireEnv} from "@/lib/env";

/**
 * `POST /d/:token/complete {commitment, wallet, signature}` - consumes the token
 * (`docs/DELEGATION.md` section 4.3 steps 4-5). See `lib/delegation/flow.ts`'s
 * `completeDelegationClaim` for the fail-closed check ordering; this route only maps its typed
 * result onto HTTP and supplies the two chain/database dependencies that function cannot reach on
 * its own, mirroring `POST /w/:token/complete`.
 *
 * On success, moves the session to `"claimed"` - an already-whitelisted operator wallet submits
 * `addSecondaryOwner` asynchronously from the VET PORTAL side (V3; the staff member who opened
 * this ceremony is watching `GET /api/pets/:id/delegations/:registrationId`, not this route).
 * `deliberately one code for both` signature checks (recovered-signer mismatch AND
 * not-yet-registered wallet) - `signature_invalid` - so a caller cannot probe which failed.
 */
export async function POST(request: Request, {params}: {params: Promise<{token: string}>}) {
  const rateLimit = enforceRateLimit(request, "delegation-complete", 10, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const {token: rawToken} = await params;
  const parsedToken = hexToken32.safeParse(rawToken);
  if (!parsedToken.success) {
    return jsonWithHeaders(errorBody("not_found", "Token unknown or malformed."), {status: 404, headers: rateLimit.headers});
  }

  const parsedBody = await readJsonBody(request, "delegation-complete");
  if (!parsedBody.ok) {
    return jsonWithHeaders(
      errorBody("signature_invalid", parsedBody.tooLarge ? "Request body is too large." : "Malformed completion request."),
      {status: 400, headers: rateLimit.headers},
    );
  }
  const parsed = completeDelegationSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return jsonWithHeaders(errorBody("signature_invalid", "Malformed completion request.", parsed.error.flatten()), {
      status: 400,
      headers: rateLimit.headers,
    });
  }

  let delegationRegistryAddress: `0x${string}`;
  try {
    delegationRegistryAddress = requireEnv("DELEGATION_REGISTRY_ADDRESS") as `0x${string}`;
  } catch {
    return jsonWithHeaders(errorBody("not_found", "This clinic has not completed setup for multi-owner tags."), {
      status: 404,
      headers: rateLimit.headers,
    });
  }

  await connectToDatabase();
  const now = Math.floor(Date.now() / 1000);
  const result = await completeDelegationClaim(
    mongoDelegationStore,
    {token: parsedToken.data, commitment: parsed.data.commitment, wallet: parsed.data.wallet, signature: parsed.data.signature},
    now,
    {
      isCommitmentActiveOnChain: (dogTagIdField, commitment) => readIsSecondary(delegationRegistryAddress, dogTagIdField, commitment as `0x${string}`),
      isRegisteredWallet: isRegisteredWalletForClient,
    },
  );

  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        return jsonWithHeaders(errorBody("not_found", "Token unknown or malformed."), {status: 404, headers: rateLimit.headers});
      case "expired_or_reused":
        return jsonWithHeaders(errorBody("expired_or_reused", "This delegation link has expired or was already used."), {
          status: 410,
          headers: rateLimit.headers,
        });
      case "signature_invalid":
        return jsonWithHeaders(errorBody("signature_invalid", "The claim signature is invalid."), {status: 400, headers: rateLimit.headers});
      case "already_secondary":
        return jsonWithHeaders(errorBody("already_secondary", "This client is already an active secondary owner of this tag."), {
          status: 409,
          headers: rateLimit.headers,
        });
    }
  }

  return jsonWithHeaders({ok: true, commitment: result.commitment, status: "claimed"}, {headers: rateLimit.headers});
}
