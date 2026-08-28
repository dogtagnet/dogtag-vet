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

/**
 * Best-effort, spoof-resistant client identity for a public request.
 *
 * The previous implementation keyed every bucket on the LEFTMOST `X-Forwarded-For` entry - the
 * one furthest from this server and closest to the original caller, which is exactly the part of
 * the header a CLIENT supplies. Nothing stops a caller from sending
 * `X-Forwarded-For: 1.2.3.4, 5.6.7.8, ...` directly; a well-behaved reverse proxy in front of this
 * app only ever APPENDS to that header (nginx's `proxy_add_x_forwarded_for`, which this app's own
 * `docs/DEPLOY.md` snippet uses, does exactly this), so the entries a client supplied are still
 * there, untouched, to the left of whatever the proxy chain added. Reading the leftmost entry
 * therefore reads attacker-controlled input every time - rotating it (as the round-6 finding
 * reproduced) defeats per-IP rate limiting completely, since every "client" looks distinct.
 *
 * The fix has two parts, in preference order:
 *
 * 1. `CF-Connecting-IP`, when present - Cloudflare's own header for "the address that actually
 *    connected to our edge," which Cloudflare sets itself and strips/overwrites any
 *    client-supplied copy of (when the deployment is genuinely proxied through Cloudflare, which
 *    `docs/DEPLOY.md` recommends as the default path).
 * 2. Otherwise, the `TRUSTED_PROXY_HOPS`-configured entry of `X-Forwarded-For`, counted from the
 *    RIGHT: with `N` trusted hops in front of this app (each of which faithfully APPENDS, like
 *    nginx's `$proxy_add_x_forwarded_for`), the `N`-th entry from the right is the address the
 *    `N`-th proxy actually observed connecting to it - real, not client-suppliable - while
 *    everything to the left of that boundary is exactly as attacker-controlled as before.
 *    `TRUSTED_PROXY_HOPS=1` (a single reverse proxy directly in front of this app, the common
 *    case) means "trust the rightmost entry."
 *
 * With neither available (`TRUSTED_PROXY_HOPS` left at its default of 0, or fewer hops present
 * than configured), this falls back to the same constant every caller previously fell back to
 * with no proxy at all: NEVER the client-controlled leftmost value. In principle the better
 * fallback here would be the raw TCP socket peer address, the way a bare `http.Server` would use
 * it directly - but there is no such thing to fall back to from inside a Next.js App Router route
 * handler in this stack: handlers receive a spec `Request`, and `NextRequest` itself dropped
 * `.ip`/`.geo` (confirmed absent from the installed `next` package's own type declarations) after
 * Next.js decided self-hosted deployments must get this from their own reverse proxy's headers
 * instead - there is no lower-level connection object exposed to reach for. The constant fallback
 * at least preserves the one property that matters: it is never something a request's own headers
 * can influence.
 */
export function clientKeyFromRequest(request: Request, trustedProxyHops = 0): string {
  const cfConnectingIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfConnectingIp) return cfConnectingIp;

  if (trustedProxyHops > 0) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const hops = forwarded
        .split(",")
        .map((hop) => hop.trim())
        .filter(Boolean);
      if (hops.length >= trustedProxyHops) {
        const trusted = hops[hops.length - trustedProxyHops];
        if (trusted) return trusted;
      }
    }
  }

  return "unknown";
}

/** Test-only: clears all buckets so tests don't leak state into each other. */
export function __resetRateLimitsForTests(): void {
  buckets.clear();
}
