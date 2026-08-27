/**
 * In-memory, per-process token-bucket rate limiter for the public routes in
 * `vet-public-api.yaml` (every one of which documents `X-RateLimit-*` response headers and a
 * `429` with `Retry-After`). In-memory is a deliberate, documented tradeoff for the one-pager
 * self-hosted deployment this template targets (a single clinic, a single web process, no shared
 * cache dependency to stand up) - a multi-instance deployment would need a shared store (Redis)
 * instead; swapping the implementation behind this same interface is the intended upgrade path.
 */

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds until the window resets. */
  resetSeconds: number;
  /** Only meaningful when `ok` is false. */
  retryAfterSeconds?: number;
}

interface Bucket {
  count: number;
  windowStartMs: number;
}

const buckets = new Map<string, Bucket>();

/** Periodically drop buckets whose window has long since expired, so a public deployment fielding
 * many distinct client keys (IPs, tokens) doesn't leak memory forever. Cheap enough to run on
 * every call rather than a separate timer - this module has no background scheduler of its own. */
function sweep(nowMs: number, windowMs: number) {
  if (buckets.size < 10_000) return;
  for (const [key, bucket] of buckets) {
    if (nowMs - bucket.windowStartMs > windowMs * 2) buckets.delete(key);
  }
}

export interface RateLimitOptions {
  /** Distinguishes this route from others sharing the same client key. */
  route: string;
  /** Caller-supplied client identity - an IP address, a session token, etc. */
  clientKey: string;
  limit: number;
  windowMs: number;
  now?: number;
}

/** Fixed-window counter: `limit` requests per `windowMs` per `(route, clientKey)`. Simpler than a
 * sliding window or true token bucket, and sufficient for the abuse patterns these routes need to
 * resist (a scraper hammering `/v1/booking/availability`, a token brute-forcer hitting `/p/:token`
 * or `/x/:token`) - it allows a short burst right at a window boundary, which is an acceptable
 * tradeoff for the simplicity of needing no background refill timer. */
export function checkRateLimit(options: RateLimitOptions): RateLimitResult {
  const nowMs = options.now ?? Date.now();
  sweep(nowMs, options.windowMs);

  const key = `${options.route}:${options.clientKey}`;
  const existing = buckets.get(key);

  if (!existing || nowMs - existing.windowStartMs >= options.windowMs) {
    buckets.set(key, {count: 1, windowStartMs: nowMs});
    return {
      ok: true,
      limit: options.limit,
      remaining: options.limit - 1,
      resetSeconds: Math.ceil(options.windowMs / 1000),
    };
  }

  const resetSeconds = Math.ceil((existing.windowStartMs + options.windowMs - nowMs) / 1000);
  if (existing.count >= options.limit) {
    return {ok: false, limit: options.limit, remaining: 0, resetSeconds, retryAfterSeconds: resetSeconds};
  }

  existing.count += 1;
  return {ok: true, limit: options.limit, remaining: options.limit - existing.count, resetSeconds};
}

/** The `X-RateLimit-*` (and, on a 429, `Retry-After`) headers every route in `vet-public-api.yaml`
 * documents on every response. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.resetSeconds),
  };
  if (result.retryAfterSeconds !== undefined) headers["Retry-After"] = String(result.retryAfterSeconds);
  return headers;
}

/** Best-effort client identity for a public request: the first hop in `X-Forwarded-For` (set by
 * the reverse proxy every deployment guide for this app puts in front of it - see
 * docs/DEPLOY.md), falling back to a constant so local dev without a proxy still rate-limits
 * (coarsely, across all callers) rather than throwing. */
export function clientKeyFromRequest(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

/** Test-only: clears all buckets so tests don't leak state into each other. */
export function __resetRateLimitsForTests(): void {
  buckets.clear();
}
