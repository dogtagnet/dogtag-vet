import {connectToDatabase} from "@/lib/db";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {Service} from "@/lib/models/Service";
import {buildEntityCard} from "@/lib/entityCard";
import {enforceRateLimit, jsonWithHeaders} from "@/lib/publicApi";

/**
 * `GET /v1/entity` - `getEntityCard` in `vet-public-api.yaml`. Served by this platform itself so
 * an app already holding the clinic's `platformBaseUrl` can render an up-to-date card without a
 * second round trip to the admin directory.
 */
export async function GET(request: Request) {
  const rateLimit = enforceRateLimit(request, "entity-card", 60, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  await connectToDatabase();
  const [settings, bookableService] = await Promise.all([
    getClinicSettings(),
    Service.exists({active: true, bookableOnline: true}),
  ]);

  const card = buildEntityCard(settings, Boolean(bookableService));
  return jsonWithHeaders(card, {headers: rateLimit.headers});
}
