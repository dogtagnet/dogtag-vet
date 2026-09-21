import "server-only";
import {readOperatorWhitelisted} from "@/lib/chainRead";
import type {OperatorStatus} from "@/lib/staffRoleTone";

/**
 * WP4.7C item 3 - the ONE shared server-side answer to "can this vet/owner actually issue
 * DogTags right now", consumed by the "My issuance wallet" card and the /tags + /tags/issue
 * banners (both server components - see their own page.tsx). Every caller gets the identical
 * five-state answer (`OperatorStatus`, defined in `staffRoleTone.ts` so it stays client-safe to
 * type-import) for the identical `(cloneAddress, walletAddress)` pair, so no surface can ever
 * show a status another surface disagrees with.
 *
 * K2 (Kenneth, verbatim): "if assigned then they can see that indeed the address is whitelisted
 * etc in their smart contract else show some warning that their address is not whitelisted...".
 * The design intent this WP was launched under is stricter than that one sentence: never show
 * "whitelisted" unless `operators(address)` actually returned true in this request or a fresh
 * cache entry, and treat a chain read that could not complete as its OWN honest state - never
 * folded into "not whitelisted", which would be a false claim about what the chain said.
 */
export type {OperatorStatus};

export interface OperatorStatusResult {
  status: OperatorStatus;
  recordedAddress?: string;
  cloneConfigured: boolean;
  /** `true` when this answer came from the short cache below rather than a fresh chain read this
   * call - surfaced mainly for tests; no caller needs to branch on it. */
  cached: boolean;
}

interface CacheEntry {
  result: OperatorStatusResult;
  expiresAtMs: number;
}

/**
 * Module-level in-memory cache - same single-process tradeoff `rateLimit.ts`'s buckets document
 * (this app targets one process per clinic; a restart just re-fetches on next use).
 * Deliberately SHORT: the event that changes this answer - the
 * DogTag protocol admin's `addOperator`/`removeOperator` transaction confirming - happens from a
 * BROWSER wallet this server has no way to be pushed a notification about, so a long-lived cache
 * would keep telling a vet they are not whitelisted for a while after the admin just fixed it
 * (this is exactly what WP4.7C item 4's e2e flow exercises: simulate the admin's grant, reload,
 * expect the status to flip). WP4.16 moved WHO submits that transaction (the DogTag protocol
 * admin's own wallet, approving an application filed in the admin portal - never this app, and
 * never an owner's wallet, both of which `VetIssuer`'s `onlyFactoryAdmin` guard always rejected)
 * but changed nothing about the shape of this cache or why it stays short.
 * Only a SUCCESSFUL read is ever cached (see the catch branch below) - an `unreadable` result is
 * never cached, so a transient RPC hiccup can never outlive its own cause.
 */
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5_000;
/** Hard upper bound on the chain read itself. This function backs SERVER-RENDERED pages (/tags,
 * /tags/issue, /settings) - an unresponsive RPC must degrade to `unreadable` quickly rather than
 * hang a page load; viem's own default transport timeout is deliberately not relied on here. */
const READ_TIMEOUT_MS = 5_000;

function cacheKey(cloneAddress: string, walletAddress: string): string {
  return `${cloneAddress.toLowerCase()}:${walletAddress.toLowerCase()}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`chain read timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * `deps.readOperator`/`deps.now`/`deps.timeoutMs` are injected so this is testable with zero
 * network access (`tests/unit/issuanceOperatorStatus.test.ts`) - every production caller omits
 * `deps` entirely and gets the real `readOperatorWhitelisted` + wall-clock `Date.now`.
 */
export async function resolveOperatorStatus(
  params: {walletAddress?: string | null; cloneAddress?: string | null},
  deps: {readOperator?: typeof readOperatorWhitelisted; now?: () => number; timeoutMs?: number} = {},
): Promise<OperatorStatusResult> {
  const readOperator = deps.readOperator ?? readOperatorWhitelisted;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? READ_TIMEOUT_MS;

  const cloneAddress = params.cloneAddress ?? undefined;
  const walletAddress = params.walletAddress ?? undefined;

  // Neither of these two early states involves a chain call at all, so neither is cached - each
  // reacts instantly (and correctly) to whatever the caller's own fresh Staff/ClinicSettings read
  // just found, with nothing stale to worry about.
  if (!cloneAddress) {
    return {status: "not-configured", recordedAddress: walletAddress, cloneConfigured: false, cached: false};
  }
  if (!walletAddress) {
    return {status: "no-address", cloneConfigured: true, cached: false};
  }

  const key = cacheKey(cloneAddress, walletAddress);
  const hit = cache.get(key);
  if (hit && hit.expiresAtMs > now()) {
    return {...hit.result, cached: true};
  }

  try {
    const isWhitelisted = await withTimeout(
      readOperator(cloneAddress as `0x${string}`, walletAddress as `0x${string}`),
      timeoutMs,
    );
    const result: OperatorStatusResult = {
      status: isWhitelisted ? "whitelisted" : "not-whitelisted",
      recordedAddress: walletAddress,
      cloneConfigured: true,
      cached: false,
    };
    cache.set(key, {result, expiresAtMs: now() + CACHE_TTL_MS});
    return result;
  } catch {
    // Fail-closed like every other reader in chainRead.ts, and NEVER cached (see the cache's own
    // doc comment) - the next call for this identical pair gets a fresh attempt, not a stale
    // failure repeated for the next CACHE_TTL_MS.
    return {status: "unreadable", recordedAddress: walletAddress, cloneConfigured: true, cached: false};
  }
}

/** Test-only: clears the module-level cache so tests don't leak state into each other. */
export function __resetOperatorStatusCacheForTests(): void {
  cache.clear();
}
