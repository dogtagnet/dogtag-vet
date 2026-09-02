import type {Address} from "viem";
import {connectToDatabase} from "@/lib/db";
import {completeImport} from "@/lib/tags/importFlow";
import {mongoImportStore} from "@/lib/tags/importMongoAdapter";
import {mongoMobileTagChainDeps, unconfiguredMobileTagChainDeps} from "@/lib/booking/mobileMongoAdapters";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {hexToken32} from "@/lib/schemas/common";
import {importCompleteSchema} from "@/lib/schemas/tagImport";
import {getServerEnv} from "@/lib/env";
import {enforceRateLimit, errorBody, jsonWithHeaders, readJsonBody} from "@/lib/publicApi";

/**
 * `POST /i/:token/complete {dogTagIdDec?, dogTagIdField?, leaves, reservedLeafHashes}` - the
 * import ceremony's consuming action (plans/wp4.9-tag-data-custody.md section 2.3). See
 * `lib/tags/importFlow.ts`'s `completeImport` for the full gate ordering and lifecycle matrix;
 * this route only maps its typed result onto HTTP, same convention as every other ceremony's
 * `/complete` route in this app.
 *
 * Reuses `lib/booking/mobileMongoAdapters.ts`'s `mongoMobileTagChainDeps`/
 * `unconfiguredMobileTagChainDeps` verbatim - the SAME `TagDataChainDeps` shape the WP4.4 booking
 * path already uses, configured/unconfigured exactly the same way (missing `DOGTAG_SBT_ADDRESS`/
 * `VET_ISSUER_FACTORY_ADDRESS`/`cloneAddress` folds every chain read to a throw, which
 * `completeImport` turns into `chain_unreadable` - never a 500).
 *
 * 400 vs 409: `malformed_claim`/`chain_unreadable`/`root_unset` (400) mean "no valid claim could be
 * established at all" (a client bug, an unreadable chain, or a tag that plain does not exist);
 * `revoked`/`verify_failed`/`already_has_active_tag` (409) mean "a real claim/target was
 * identified, but its CURRENT state conflicts with completing this import" - the same distinction
 * documented in the synced-copy spec.
 */
export async function POST(request: Request, {params}: {params: Promise<{token: string}>}) {
  const rateLimit = enforceRateLimit(request, "artifact-import-complete", 10, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const {token: rawToken} = await params;
  const parsedToken = hexToken32.safeParse(rawToken);
  if (!parsedToken.success) {
    return jsonWithHeaders(errorBody("not_found", "Token unknown or malformed."), {
      status: 404,
      headers: rateLimit.headers,
    });
  }

  const parsedBody = await readJsonBody(request, "artifact-import-complete");
  if (!parsedBody.ok) {
    return jsonWithHeaders(
      errorBody("malformed_claim", parsedBody.tooLarge ? "Request body is too large." : "Malformed completion request."),
      {status: 400, headers: rateLimit.headers},
    );
  }
  const parsed = importCompleteSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return jsonWithHeaders(errorBody("malformed_claim", "Malformed completion request.", parsed.error.flatten()), {
      status: 400,
      headers: rateLimit.headers,
    });
  }

  await connectToDatabase();
  const env = getServerEnv();
  const settings = await getClinicSettings();
  const chainDeps =
    env.DOGTAG_SBT_ADDRESS && env.VET_ISSUER_FACTORY_ADDRESS && settings?.cloneAddress
      ? mongoMobileTagChainDeps(env.DOGTAG_SBT_ADDRESS as Address, env.VET_ISSUER_FACTORY_ADDRESS as Address)
      : unconfiguredMobileTagChainDeps();

  const now = Math.floor(Date.now() / 1000);
  const result = await completeImport(
    mongoImportStore,
    chainDeps,
    {
      token: parsedToken.data,
      dogTagIdDec: parsed.data.dogTagIdDec,
      dogTagIdField: parsed.data.dogTagIdField,
      leaves: parsed.data.leaves,
      reservedLeafHashes: parsed.data.reservedLeafHashes,
    },
    now,
  );

  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        return jsonWithHeaders(errorBody("not_found", "Token unknown or malformed."), {status: 404, headers: rateLimit.headers});
      case "expired_or_reused":
        return jsonWithHeaders(errorBody("expired_or_reused", "This code has expired or was already used."), {
          status: 410,
          headers: rateLimit.headers,
        });
      case "malformed_claim":
        return jsonWithHeaders(errorBody("malformed_claim", "dogTagIdDec and dogTagIdField do not agree with each other."), {
          status: 400,
          headers: rateLimit.headers,
        });
      case "chain_unreadable":
        return jsonWithHeaders(
          errorBody("chain_unreadable", "Could not reach the chain to verify this tag right now. Generate a new code and try again."),
          {status: 400, headers: rateLimit.headers},
        );
      case "root_unset":
        return jsonWithHeaders(errorBody("root_unset", "This tag has never been issued on chain."), {
          status: 400,
          headers: rateLimit.headers,
        });
      case "revoked":
        return jsonWithHeaders(errorBody("revoked", "This tag has been revoked at the issuing clinic and cannot be imported."), {
          status: 409,
          headers: rateLimit.headers,
        });
      case "verify_failed":
        return jsonWithHeaders(errorBody("verify_failed", "The submitted data does not match what is on chain for this tag."), {
          status: 409,
          headers: rateLimit.headers,
        });
      case "already_has_active_tag":
        return jsonWithHeaders(
          errorBody("already_has_active_tag", "This pet already has an active tag. Revoke or replace it first, or import onto a different pet."),
          {status: 409, headers: rateLimit.headers},
        );
    }
  }

  return jsonWithHeaders(
    {ok: true, petId: result.petId, petName: result.petName, created: result.created, conflicts: result.conflicts},
    {headers: rateLimit.headers},
  );
}
