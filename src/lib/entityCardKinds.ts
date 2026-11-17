import "server-only";
import {entityKindsFromMask, type EntityKindId} from "@dogtag/standard";
import type {ClinicSettingsDoc} from "@/lib/models/ClinicSettings";
import {readEntityKinds} from "@/lib/chainRead";
import {getServerEnv} from "@/lib/env";
import {DEFAULT_ENTITY_KINDS} from "@/lib/entityCard";

type Address = `0x${string}`;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** A read gets at most this long before the card answers the default (the kinds are informational). */
export const ENTITY_CARD_KINDS_DEADLINE_MS = 2500;
/** A `registered` or `not_registered` answer is reused this long. */
export const ENTITY_CARD_KINDS_TTL_MS = 60_000;
/** An unreadable or timed-out answer is reused this long, so a down chain costs one bounded wait per window. */
export const ENTITY_CARD_KINDS_FAILURE_TTL_MS = 30_000;

type CacheEntry = {kinds: EntityKindId[]; expiresAt: number};
type TimerHandle = unknown;

/** Per-process cache and in-flight reads, keyed by registry and account. */
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<EntityKindId[]>>();

/** Test hook: forget every cached and in-flight answer. */
export function clearEntityCardKindsCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * The kinds `GET /v1/entity` reports for this clinic (WP4.21, plan 2.11): read from the registry for
 * the clinic's OWN entity account. Kinds are a record only, so this can never fail the card: no
 * registry configured, no (valid) entity account, an unregistered account, an unreadable chain, a
 * read slower than the deadline, or a mask with no kind this build knows all resolve to the default
 * `["VET"]`. The card is public and the kinds informational, so the read is bounded (deadline) and
 * cached (60 s for a registered or not_registered answer, 30 s for an unreadable or timed-out one),
 * and concurrent calls share one read. `read`, `now` and the timer are injectable so the unit tests
 * need no chain and no real waiting.
 */
export async function resolveEntityCardKinds(
  settings: Pick<ClinicSettingsDoc, "entityAccount">,
  deps: {
    registryAddress?: string;
    read?: typeof readEntityKinds;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => TimerHandle;
    clearTimer?: (handle: TimerHandle) => void;
    deadlineMs?: number;
  } = {},
): Promise<EntityKindId[]> {
  const registry = deps.registryAddress ?? getServerEnv().ENTITY_REGISTRY_ADDRESS;
  const account = settings.entityAccount;
  if (!registry || !ADDRESS_RE.test(registry) || !account || !ADDRESS_RE.test(account)) return [...DEFAULT_ENTITY_KINDS];

  const now = deps.now ?? Date.now;
  const key = `${registry.toLowerCase()}:${account.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) return [...hit.kinds];
  const pending = inflight.get(key);
  if (pending) return [...(await pending)];

  const run = (async (): Promise<EntityKindId[]> => {
    let ok = false;
    let kinds: EntityKindId[] = [...DEFAULT_ENTITY_KINDS];
    const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    let handle: TimerHandle;
    try {
      const timedOut = new Promise<"timeout">((resolve) => {
        handle = setTimer(() => resolve("timeout"), deps.deadlineMs ?? ENTITY_CARD_KINDS_DEADLINE_MS);
      });
      const read = (deps.read ?? readEntityKinds)(registry as Address, account as Address);
      read.catch(() => undefined); // a read that loses the race may still reject later
      const result = await Promise.race([read, timedOut]);
      if (result !== "timeout" && (result.status === "registered" || result.status === "not_registered")) {
        ok = true;
        if (result.status === "registered") {
          const known = entityKindsFromMask(result.mask);
          if (known.length > 0) kinds = known;
        }
      }
    } catch {
      // unreadable: the default stands
    } finally {
      clearTimer(handle);
    }
    cache.set(key, {kinds, expiresAt: now() + (ok ? ENTITY_CARD_KINDS_TTL_MS : ENTITY_CARD_KINDS_FAILURE_TTL_MS)});
    return kinds;
  })().finally(() => inflight.delete(key));
  inflight.set(key, run);
  return [...(await run)];
}
