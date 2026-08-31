import {connectToDatabase} from "@/lib/db";
import {completeRegistration} from "@/lib/registration/flow";
import {mongoRegistrationStore} from "@/lib/registration/mongoStore";
import {hexToken32} from "@/lib/schemas/common";
import {completeWalletRegistrationSchema} from "@/lib/schemas/walletRegistration";
import {enforceRateLimit, errorBody, jsonWithHeaders, readJsonBody} from "@/lib/publicApi";

/**
 * `POST /w/:token/complete {wallet, signature}` - consumes the token
 * (plans/wp4.2-client-wallet-registration.md, dogtag-vet section 4). See
 * `lib/registration/flow.ts`'s `completeRegistration` for the fail-closed check ordering; this
 * route only maps its typed result onto HTTP, exactly like `POST /profiles/issue/custodial-bind`
 * does for mint's own `custodialBind`.
 *
 * Fail codes mirror the spec's list exactly: `not_found` (404), `expired_or_reused` (410, covers
 * BOTH a token that was already consumed and one that simply expired - registration has no
 * `already_bound`-style 409 payload the way mint does, since there is no dogTagId to report),
 * `signature_invalid` (400), `already_registered` (409, same wallet already on this client).
 */
export async function POST(request: Request, {params}: {params: Promise<{token: string}>}) {
  const rateLimit = enforceRateLimit(request, "wallet-registration-complete", 10, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const {token: rawToken} = await params;
  const parsedToken = hexToken32.safeParse(rawToken);
  if (!parsedToken.success) {
    return jsonWithHeaders(errorBody("not_found", "Token unknown or malformed."), {
      status: 404,
      headers: rateLimit.headers,
    });
  }

  const parsedBody = await readJsonBody(request, "wallet-registration-complete");
  if (!parsedBody.ok) {
    return jsonWithHeaders(
      errorBody("signature_invalid", parsedBody.tooLarge ? "Request body is too large." : "Malformed completion request."),
      {status: 400, headers: rateLimit.headers},
    );
  }
  const parsed = completeWalletRegistrationSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return jsonWithHeaders(errorBody("signature_invalid", "Malformed completion request.", parsed.error.flatten()), {
      status: 400,
      headers: rateLimit.headers,
    });
  }

  await connectToDatabase();
  const now = Math.floor(Date.now() / 1000);
  const result = await completeRegistration(
    mongoRegistrationStore,
    {token: parsedToken.data, wallet: parsed.data.wallet, signature: parsed.data.signature},
    now,
  );

  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        return jsonWithHeaders(errorBody("not_found", "Token unknown or malformed."), {
          status: 404,
          headers: rateLimit.headers,
        });
      case "expired_or_reused":
        return jsonWithHeaders(errorBody("expired_or_reused", "This registration link has expired or was already used."), {
          status: 410,
          headers: rateLimit.headers,
        });
      case "signature_invalid":
        return jsonWithHeaders(
          errorBody("signature_invalid", "The signature does not match the wallet being registered."),
          {status: 400, headers: rateLimit.headers},
        );
      case "already_registered":
        return jsonWithHeaders(errorBody("already_registered", "This wallet is already registered to this client."), {
          status: 409,
          headers: rateLimit.headers,
        });
    }
  }

  return jsonWithHeaders({ok: true, wallet: result.wallet, receiptHash: result.receiptHash}, {headers: rateLimit.headers});
}
