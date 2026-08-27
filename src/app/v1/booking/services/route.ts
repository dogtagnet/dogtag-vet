import {connectToDatabase} from "@/lib/db";
import {Service, type ServiceDoc} from "@/lib/models/Service";
import {enforceRateLimit, jsonWithHeaders} from "@/lib/publicApi";

/** `GET /v1/booking/services` - `vet-public-api.yaml`: a bare JSON array of `BookingService`. */
export async function GET(request: Request) {
  const rateLimit = enforceRateLimit(request, "booking-services", 60, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  await connectToDatabase();
  const services = await Service.find({active: true, bookableOnline: true})
    .sort({name: 1})
    .lean<ServiceDoc[]>();

  const body = services.map((s) => ({
    id: s.serviceId,
    name: s.name,
    ...(s.description ? {description: s.description} : {}),
    durationMinutes: s.durationMinutes,
    ...(s.price ? {price: s.price} : {}),
  }));

  return jsonWithHeaders(body, {headers: rateLimit.headers});
}
