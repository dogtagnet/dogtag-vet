import {connectToDatabase} from "@/lib/db";
import {resolveImportSession} from "@/lib/tags/importFlow";
import {mongoImportStore} from "@/lib/tags/importMongoAdapter";
import {hexToken32} from "@/lib/schemas/common";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";

/**
 * `GET /i/:token` - the import ceremony's resolve step (plans/wp4.9-tag-data-custody.md section
 * 2.3). Mobile-facing, non-consuming (mirrors `GET /w/:token` exactly) - lets the owner's app show
 * a confirmation screen ("send your tag's data to <clinicName>, for <target>") before it ever
 * submits anything. `POST /i/:token/complete` is the consuming action.
 */
export async function GET(request: Request, {params}: {params: Promise<{token: string}>}) {
  const rateLimit = enforceRateLimit(request, "artifact-import-resolve", 30, 60_000);
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
  const result = await resolveImportSession(mongoImportStore, parsedToken.data, now);

  if (!result.ok) {
    const message = result.code === "not_found" ? "Token unknown or malformed." : "This code has expired or was already used.";
    return jsonWithHeaders(errorBody(result.code, message), {
      status: result.code === "not_found" ? 404 : 410,
      headers: rateLimit.headers,
    });
  }

  return jsonWithHeaders(
    {
      clinicName: result.clinicName,
      isNewPet: result.isNewPet,
      targetPetName: result.targetPetName,
      ttlSecs: result.ttlSecs,
    },
    {headers: rateLimit.headers},
  );
}
