import type {PaymentToken} from "@/lib/models/Payment";

/** CoinGecko's `/simple/price` ids for the three tokens this app quotes. ETH's id is `ethereum`
 * regardless of which of the four chains it is being paid on - CoinGecko prices the asset, not the
 * chain it is currently sitting on. */
const COINGECKO_IDS: Record<PaymentToken, string> = {
  ETH: "ethereum",
  USDC: "usd-coin",
  USDT: "tether",
};

const CACHE_TTL_MS = 10 * 60 * 1000; // wp4-vet.md: "10-minute cache"

export type FetchLike = (url: string) => Promise<{ok: boolean; json: () => Promise<unknown>}>;

interface CacheEntry {
  rate: string;
  fetchedAtMs: number;
}

/**
 * Module-level in-memory cache - same documented tradeoff as `rateLimit.ts`'s buckets: this app
 * targets a single-process, single-clinic deployment, so a process restart simply re-fetches on
 * next use rather than losing anything durable. A multi-instance deployment would need a shared
 * cache instead.
 */
const cache = new Map<string, CacheEntry>();

export type QuoteResult =
  | {ok: true; rate: string; source: "live" | "cached"}
  | {ok: false; staleRate?: string};

/**
 * Fetches token's spot price in `fiatCurrency` from CoinGecko's simple-price API (no key
 * required). On a live fetch failure, returns the last cached rate as `staleRate` (the caller
 * decides whether a rate this old is still acceptable, or whether to fall back to a staff-entered
 * manual rate per wp4-vet.md) rather than throwing - a quote failure must never itself fail
 * payment creation.
 *
 * `deps.fetchImpl` and `deps.now` are injected so this is testable with zero network access
 * (`tests/unit/priceFeed.test.ts`); production callers pass the global `fetch` and `Date.now`.
 */
export async function getSpotRate(
  deps: {fetchImpl: FetchLike; now: number; apiBase: string},
  token: PaymentToken,
  fiatCurrency: string,
): Promise<QuoteResult> {
  const cacheKey = `${token}:${fiatCurrency.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && deps.now - cached.fetchedAtMs < CACHE_TTL_MS) {
    return {ok: true, rate: cached.rate, source: "cached"};
  }

  const coingeckoId = COINGECKO_IDS[token];
  const url = `${deps.apiBase.replace(/\/$/, "")}/simple/price?ids=${coingeckoId}&vs_currencies=${fiatCurrency.toLowerCase()}`;

  try {
    const res = await deps.fetchImpl(url);
    if (!res.ok) throw new Error(`CoinGecko responded ${res}`);
    const body = (await res.json()) as Record<string, Record<string, number>>;
    const price = body[coingeckoId]?.[fiatCurrency.toLowerCase()];
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      throw new Error("CoinGecko response missing a usable price");
    }
    const rate = String(price);
    cache.set(cacheKey, {rate, fetchedAtMs: deps.now});
    return {ok: true, rate, source: "live"};
  } catch {
    return cached ? {ok: false, staleRate: cached.rate} : {ok: false};
  }
}

/** Test-only: clears the module-level cache so tests don't leak state into each other. */
export function __resetPriceCacheForTests(): void {
  cache.clear();
}
