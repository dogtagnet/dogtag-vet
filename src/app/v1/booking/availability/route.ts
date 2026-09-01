import {computeAvailability, computePractitionerAvailability} from "@/lib/booking/availability";
import {
  listBookablePractitioners,
  loadAvailabilityConfig,
  loadExistingOccupiedIntervals,
  loadPractitionerOccupiedIntervals,
  loadPractitionerRulesAndExceptions,
} from "@/lib/booking/queries";
import {connectToDatabase} from "@/lib/db";
import {Service, type ServiceDoc} from "@/lib/models/Service";
import {bookingAvailabilityQuerySchema} from "@/lib/schemas/booking";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";

const MAX_RANGE_DAYS = 31;

/**
 * `GET /v1/booking/availability` - `vet-public-api.yaml`: `{slots: [{startAt, endAt}]}`, both as
 * ISO 8601 instants. `serviceId` unknown, `to <= from`, or a range over 31 days all return `400`.
 *
 * WP4.7 D5: in `schedulingMode: "practitioner"` ONLY, the response additionally carries a
 * `practitioners: [{id, name}]` roster and each slot gains `practitionerIds: [string]` (every
 * practitioner free at that exact instant). Whole-clinic mode's response is BYTE-IDENTICAL to
 * before this WP - neither key is ever present, not even as an empty array - old clients (and the
 * existing WP4.4 vector tests) see exactly the same wire shape they always have.
 */
export async function GET(request: Request) {
  const rateLimit = enforceRateLimit(request, "booking-availability", 60, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const url = new URL(request.url);
  const parsedQuery = bookingAvailabilityQuerySchema.safeParse({
    serviceId: url.searchParams.get("serviceId") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });
  if (!parsedQuery.success) {
    return jsonWithHeaders(errorBody("invalid_input", "serviceId, from, and to are required."), {
      status: 400,
      headers: rateLimit.headers,
    });
  }

  const fromMs = Date.parse(parsedQuery.data.from);
  const toMs = Date.parse(parsedQuery.data.to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return jsonWithHeaders(errorBody("invalid_input", "from and to must be ISO 8601 instants."), {
      status: 400,
      headers: rateLimit.headers,
    });
  }
  const fromUtc = Math.floor(fromMs / 1000);
  const toUtc = Math.floor(toMs / 1000);
  if (toUtc <= fromUtc) {
    return jsonWithHeaders(errorBody("invalid_input", "to must be after from."), {
      status: 400,
      headers: rateLimit.headers,
    });
  }
  if (toUtc - fromUtc > MAX_RANGE_DAYS * 86400) {
    return jsonWithHeaders(errorBody("invalid_input", `The range must not exceed ${MAX_RANGE_DAYS} days.`), {
      status: 400,
      headers: rateLimit.headers,
    });
  }

  await connectToDatabase();
  const service = await Service.findOne({
    serviceId: parsedQuery.data.serviceId,
    active: true,
    bookableOnline: true,
  }).lean<ServiceDoc>();
  if (!service) {
    return jsonWithHeaders(errorBody("service_not_found", "Unknown or unbookable service."), {
      status: 400,
      headers: rateLimit.headers,
    });
  }

  const config = await loadAvailabilityConfig();
  const now = Math.floor(Date.now() / 1000);
  const serviceForAvailability = {
    durationMinutes: service.durationMinutes,
    bufferBeforeMin: service.bufferBeforeMin,
    bufferAfterMin: service.bufferAfterMin,
  };

  if (config.settings.schedulingMode === "practitioner") {
    const bookable = await listBookablePractitioners();
    const staffIds = bookable.map((p) => p.staffId);
    const [rulesMap, occupiedMap] = await Promise.all([
      loadPractitionerRulesAndExceptions(staffIds),
      loadPractitionerOccupiedIntervals(fromUtc, toUtc, staffIds),
    ]);

    const slots = computePractitionerAvailability({
      service: serviceForAvailability,
      practitioners: staffIds.map((staffId) => ({
        staffId,
        rules: rulesMap.get(staffId)?.rules ?? [],
        exceptions: rulesMap.get(staffId)?.exceptions ?? [],
        occupied: occupiedMap.get(staffId) ?? [],
      })),
      settings: config.settings,
      fromUtc,
      toUtc,
      now,
    });

    return jsonWithHeaders(
      {
        slots: slots.map((s) => ({
          startAt: new Date(s.startAt * 1000).toISOString(),
          endAt: new Date(s.endAt * 1000).toISOString(),
          practitionerIds: s.practitionerIds,
        })),
        practitioners: bookable.map((p) => ({id: p.staffId, name: p.name})),
      },
      {headers: rateLimit.headers},
    );
  }

  const existingOccupied = await loadExistingOccupiedIntervals(fromUtc, toUtc);
  const slots = computeAvailability({
    service: serviceForAvailability,
    rules: config.rules,
    exceptions: config.exceptions,
    settings: config.settings,
    existingOccupied,
    fromUtc,
    toUtc,
    now,
  });

  return jsonWithHeaders(
    {
      slots: slots.map((s) => ({
        startAt: new Date(s.startAt * 1000).toISOString(),
        endAt: new Date(s.endAt * 1000).toISOString(),
      })),
    },
    {headers: rateLimit.headers},
  );
}
