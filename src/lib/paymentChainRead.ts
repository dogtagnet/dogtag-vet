import "server-only";
import {createPublicClient, http, type PublicClient} from "viem";
import {paymentChainByKey, type PaymentChainKey} from "@/lib/chains";
import {getServerEnv} from "@/lib/env";
import type {RpcOverrides} from "@/lib/models/ClinicSettings";

// `paymentChainByKey`'s entry is its own chain-const literal type (viem infers a specific
// `formatters`/transaction shape per chain), so a function returning "whichever one was requested"
// cannot be typed as `ReturnType<typeof createPublicClient>` without that chain's generic - kept
// as a `Record`-keyed lookup rather than a bare constant even with one entry today, since a future
// second chain (plans/wp4.18-roax-payments.md section 7) is a registry addition here, never a
// rewrite. Every call site here only ever does chain-agnostic reads (`getBlockNumber`, `getBlock`,
// `getContractEvents`), so the generic default `PublicClient` (no chain type parameter) is
// deliberately what this module exposes; the cast below is narrowing a real, compatible value to
// that looser type, not asserting something false.
const clients = new Map<string, PublicClient>();

const ENV_RPC: Record<PaymentChainKey, keyof ReturnType<typeof getServerEnv>> = {
  roax: "ROAX_RPC_URL",
};

let assertedRoaxChainId: number | undefined;

/**
 * The ROAX payment chain's numeric id, read from `ROAX_CHAIN_ID` and validated ONCE per process -
 * a misconfigured non-positive-integer value throws immediately the first time anything in the
 * payment path (EIP-681 URI building, the watcher's chain-id-embedding rail lookups) actually
 * needs it, per wp4.18-roax-payments.md V1's "startup assertion that the ROAX chain id is a
 * positive integer".
 *
 * Deliberately lazy (memoized on first call, never at module-evaluation time), mirroring
 * `env.ts`'s own "never throws at module-evaluation time" contract: `next build` on a bare
 * checkout with no `.env` file must stay green, and it does, since `ROAX_CHAIN_ID`'s schema
 * default (135) is itself a valid positive integer - this only ever throws once an operator has
 * explicitly set a bad override.
 *
 * Deliberately NOT the same read path as `chains.ts`'s client-safe `roax.id` (itself sourced from
 * `publicEnv.roaxChainId`, which - server-side, with no injected `window` - falls back to the
 * BUILD-TIME `NEXT_PUBLIC_ROAX_CHAIN_ID` rather than the live `ROAX_CHAIN_ID`; see
 * `env.public.ts`'s own doc comment on that gap): the identity chain's `roax.id` only ever reaches
 * rendered text behind client-only gates where a stale value self-heals on hydration, but a wrong
 * chain id embedded in a payment EIP-681 URI would send a payer's wallet at the wrong network, so
 * the money-critical payment path reads and validates the server env value directly instead of
 * inheriting that documented gap. `TOKEN_RUSD_ROAX_ADDRESS` and the four other protocol contract
 * addresses have no such twin problem (they are not RPC/chain-id state, so this asymmetry is
 * specific to the chain id and RPC URL alone).
 */
export function roaxChainId(): number {
  if (assertedRoaxChainId === undefined) {
    const id = getServerEnv().ROAX_CHAIN_ID;
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`ROAX_CHAIN_ID must be a positive integer chain id, got ${JSON.stringify(id)}. Fix ROAX_CHAIN_ID in the environment.`);
    }
    assertedRoaxChainId = id;
  }
  return assertedRoaxChainId;
}

/** Read-only public client for one payment chain. RPC URL precedence: the clinic's own
 * Settings-page override (`rpcOverrides`, checked fresh every call since it can change at
 * runtime without a redeploy) beats the env default beats the chain's own hardcoded fallback -
 * wp4-vet.md's "public RPC endpoints per chain from env with sensible defaults, override-able".
 * Clients ARE cached per chain per resolved URL, so a settings change takes effect on the next
 * watcher tick rather than needing a process restart. */
export function paymentPublicClient(chainKey: PaymentChainKey, rpcOverrides: RpcOverrides): PublicClient {
  const url = rpcOverrides[chainKey] || (getServerEnv()[ENV_RPC[chainKey]] as string);
  const cacheKey = `${chainKey}:${url}`;
  const cached = clients.get(cacheKey);
  if (cached) return cached;

  const client = createPublicClient({chain: paymentChainByKey[chainKey], transport: http(url)}) as PublicClient;
  clients.set(cacheKey, client);
  return client;
}
