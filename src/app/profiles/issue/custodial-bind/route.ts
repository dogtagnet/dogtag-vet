import {connectToDatabase} from "@/lib/db";
import {custodialBind} from "@/lib/mint/flow";
import {mongoMintStore} from "@/lib/mint/mongoStore";
import {isDogTagIdUnset} from "@/lib/mint/chainChecks";
import {custodialBindRequestSchema} from "@/lib/schemas/mintSession";
import {enforceRateLimit, errorBody, jsonWithHeaders, readJsonBody} from "@/lib/publicApi";

/**
 * `POST /profiles/issue/custodial-bind` - `postCustodialBind` in `vet-public-api.yaml`. See
 * `lib/mint/flow.ts`'s `custodialBind` for the fail-closed check ordering, and its
 * `CustodialBindResult`'s `already_bound` doc comment for the 409-vs-410 reasoning (a reused,
 * already-consumed token is 409 with `error.details.dogTagId`, per the yaml's documented payload;
 * 410 is reserved for a token that was never consumed and simply expired).
 */
export async function POST(request: Request) {
  const rateLimit = enforceRateLimit(request, "mint-bind", 20, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const parsedBody = await readJsonBody(request, "mint-bind");
  if (!parsedBody.ok) {
    return jsonWithHeaders(
      errorBody("malformed_leaf", parsedBody.tooLarge ? "Request body is too large." : "Malformed bind request."),
      {status: 400, headers: rateLimit.headers},
    );
  }
  const parsed = custodialBindRequestSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return jsonWithHeaders(errorBody("malformed_leaf", "Malformed bind request.", parsed.error.flatten()), {
      status: 400,
      headers: rateLimit.headers,
    });
  }

  await connectToDatabase();
  const now = Math.floor(Date.now() / 1000);

  let result;
  try {
    result = await custodialBind(mongoMintStore, parsed.data, now, isDogTagIdUnset);
  } catch (err) {
    // Last-resort net, not the primary fix: `custodialBind` itself already catches the one call
    // in its post-consume path that is expected to throw (the on-chain re-check) and turns it into
    // the `transient_error` result handled below. This only guards against something else in that
    // path throwing unexpectedly (a database blip on `markError`/`commitReady` themselves, say) -
    // it exists so THAT case also answers the yaml's documented `Error`-shaped 5XX rather than an
    // uncaught, bodyless 500, never so a thrown error is silently swallowed.
    console.error("[custodial-bind] unhandled error:", err);
    return jsonWithHeaders(errorBody("transient_error", "Temporarily unable to complete this request. Retry shortly."), {
      status: 503,
      headers: rateLimit.headers,
    });
  }

  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        return jsonWithHeaders(errorBody("token_not_found", "Token unknown or malformed."), {
          status: 404,
          headers: rateLimit.headers,
        });
      case "expired_or_reused":
        return jsonWithHeaders(errorBody("token_expired", "Token expired, or was never valid."), {
          status: 410,
          headers: rateLimit.headers,
        });
      case "already_bound":
        return jsonWithHeaders(
          errorBody("already_bound", "This token was already successfully bound.", {dogTagId: result.dogTagIdDec}),
          {status: 409, headers: rateLimit.headers},
        );
      case "leaf_commitment_invalid":
        return jsonWithHeaders(
          errorBody("leaf_commitment_invalid", "The submitted profile tree does not match the vet's records."),
          {status: 400, headers: rateLimit.headers},
        );
      case "seal_conflict":
        return jsonWithHeaders(errorBody("seal_conflict", "This tag was already sealed."), {
          status: 409,
          headers: rateLimit.headers,
        });
      case "transient_error":
        // The session is already marked `error`/`seal` by `custodialBind` before this result is
        // returned, so it is immediately retryable via `/api/tags/issue/:sessionId/retry` (a fresh
        // token, same dogTagId) - the operator-side recovery path the spec's issuance step 7 names.
        return jsonWithHeaders(
          errorBody("transient_error", "Temporarily unable to complete this request. Retry shortly."),
          {status: 503, headers: rateLimit.headers},
        );
    }
  }

  const {session} = result;
  return jsonWithHeaders(
    {
      dogTagId: session.dogTagIdDec,
      onchainDogTagId: session.dogTagIdFieldDec,
      root: session.root,
      protocolVersion: "dogtag-v2/1",
      status: session.status,
    },
    {headers: rateLimit.headers},
  );
}
