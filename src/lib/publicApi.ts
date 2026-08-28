import "server-only";
import {NextResponse} from "next/server";
import {checkRateLimit, clientKeyFromRequest, rateLimitHeaders, type RateLimitResult} from "@/lib/rateLimit";
import {recordAbuse} from "@/lib/abuseLog";
import {readJsonBody as readJsonBodyRaw, type ReadJsonBodyResult} from "@/lib/bodyLimit";

export type {ReadJsonBodyResult} from "@/lib/bodyLimit";

/** The `{error: {code, message, ...}}` envelope every route in `vet-public-api.yaml` uses. */
export function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return {error: {code, message, ...(details ? {details} : {})}};
}

export function jsonWithHeaders(body: unknown, init: {status?: number; headers?: Record<string, string>} = {}) {
  return NextResponse.json(body, {status: init.status ?? 200, headers: init.headers});
}

/**
 * Runs `checkRateLimit` for `route` against the caller's IP (best-effort, `X-Forwarded-For`) and
 * returns either `{limited: false, headers}` - the `X-RateLimit-*` headers to attach to the
 * eventual success response - or `{limited: true, response}` - a ready-to-return `429` with
 * `Retry-After` set, per every route's documented rate-limit behavior in `vet-public-api.yaml`.
 */
export function enforceRateLimit(
  request: Request,
  route: string,
  limit: number,
  windowMs: number,
): {limited: false; headers: Record<string, string>} | {limited: true; response: NextResponse} {
  const result: RateLimitResult = checkRateLimit({
    route,
    clientKey: clientKeyFromRequest(request),
    limit,
    windowMs,
  });
  const headers = rateLimitHeaders(result);
  if (!result.ok) {
    void recordAbuse(route, clientKeyFromRequest(request), "rate_limited");
    return {
      limited: true,
      response: jsonWithHeaders(errorBody("rate_limited", "Too many requests. Try again shortly."), {
        status: 429,
        headers,
      }),
    };
  }
  return {limited: false, headers};
}

/**
 * `readJsonBody` for a specific public route, additionally recording an abuse-log entry when the
 * body is rejected for being oversized (not for ordinary malformed JSON, which is normal client
 * error traffic rather than abuse). Fire-and-forget, same as `enforceRateLimit`'s own logging -
 * never adds latency or a new failure mode to the request itself.
 */
export async function readJsonBody(request: Request, route: string): Promise<ReadJsonBodyResult> {
  const result = await readJsonBodyRaw(request);
  if (!result.ok && result.tooLarge) {
    void recordAbuse(route, clientKeyFromRequest(request), "body_too_large");
  }
  return result;
}
