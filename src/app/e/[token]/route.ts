import {connectToDatabase} from "@/lib/db";
import {resolveAndConsumeExport} from "@/lib/tags/exportFlow";
import {mongoExportStore} from "@/lib/tags/exportMongoAdapter";
import {resolveAndConsumeRecordExport} from "@/lib/records/exportFlow";
import {mongoRecordExportStore} from "@/lib/records/exportMongoAdapter";
import {peekExportSessionArtifactType} from "@/lib/exportSessionDispatch";
import {hexToken32} from "@/lib/schemas/common";
import {roax} from "@/lib/chains";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";

/**
 * `GET /e/:token` - the export ceremony's public fetch (plans/wp4.9-tag-data-custody.md section
 * 2.2, extended by WP4.14 V5 to also serve a record's `RecordArtifact`). Mobile-facing, ONE-TIME:
 * unlike `/w/:token`/`/x/:token`, this single GET both resolves AND atomically consumes the token -
 * there is no separate `/complete` step because there is nothing for the phone to submit back; it
 * only ever reads. See `lib/tags/exportFlow.ts`'s `resolveAndConsumeExport` (tag) and `lib/records/
 * exportFlow.ts`'s `resolveAndConsumeRecordExport` (record) for the full ordering and why a
 * revoked/superseded refusal still burns the token.
 *
 * `peekExportSessionArtifactType` decides which of the two ceremonies owns this token BEFORE either
 * one's own (consuming) logic runs - a read-only peek that costs one extra indexed lookup, kept
 * deliberately OUTSIDE both flows so the tag path below is completely unchanged: same function, same
 * store, same call, same response shape as before WP4.14.
 *
 * `revoked` and `superseded` both fold to 410, the same status `expired_or_reused` already uses -
 * from the scanning phone's perspective all three mean "this code will never produce data now, get
 * a new one from the clinic", even though the `code` field (and therefore the copy shown) differs.
 */
export async function GET(request: Request, {params}: {params: Promise<{token: string}>}) {
  const rateLimit = enforceRateLimit(request, "artifact-export-resolve", 30, 60_000);
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
  const kind = await peekExportSessionArtifactType(parsedToken.data);

  if (kind === "record") {
    const result = await resolveAndConsumeRecordExport(mongoRecordExportStore, parsedToken.data, now);
    if (!result.ok) {
      switch (result.code) {
        case "not_found":
          return jsonWithHeaders(errorBody("not_found", "Token unknown or malformed."), {
            status: 404,
            headers: rateLimit.headers,
          });
        case "expired_or_reused":
          return jsonWithHeaders(errorBody("expired_or_reused", "This code has expired or was already used."), {
            status: 410,
            headers: rateLimit.headers,
          });
        case "revoked":
          return jsonWithHeaders(
            errorBody("revoked", "This record has been revoked and its data can no longer be shared this way."),
            {status: 410, headers: rateLimit.headers},
          );
        case "internal_error":
          return jsonWithHeaders(
            errorBody("internal_error", "Something went wrong preparing this record's data. Ask the clinic for a new code."),
            {status: 500, headers: rateLimit.headers},
          );
      }
    }
    return jsonWithHeaders({...result.data, chainId: roax.id}, {headers: rateLimit.headers});
  }

  const result = await resolveAndConsumeExport(mongoExportStore, parsedToken.data, now);

  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        return jsonWithHeaders(errorBody("not_found", "Token unknown or malformed."), {
          status: 404,
          headers: rateLimit.headers,
        });
      case "expired_or_reused":
        return jsonWithHeaders(errorBody("expired_or_reused", "This code has expired or was already used."), {
          status: 410,
          headers: rateLimit.headers,
        });
      case "revoked":
        return jsonWithHeaders(
          errorBody("revoked", "This tag has been revoked and its data can no longer be shared this way."),
          {status: 410, headers: rateLimit.headers},
        );
      case "superseded":
        return jsonWithHeaders(
          errorBody("superseded", "This tag's data has changed since this code was generated. Ask the clinic for a new code."),
          {status: 410, headers: rateLimit.headers},
        );
      case "internal_error":
        // WP4.10V item 3's self-check safety net (exportFlow.ts's own doc comment) already logged
        // the specifics server-side - never leak them to the scanning phone. The token is already
        // consumed at this point; there is no retry endpoint, matching every other refusal here.
        return jsonWithHeaders(errorBody("internal_error", "Something went wrong preparing this tag's data. Ask the clinic for a new code."), {
          status: 500,
          headers: rateLimit.headers,
        });
    }
  }

  return jsonWithHeaders({...result.data, chainId: roax.id}, {headers: rateLimit.headers});
}
