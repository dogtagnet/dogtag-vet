import "server-only";
import {createPublicClient, http, type PublicClient} from "viem";
import {paymentChainByKey, type PaymentChainKey} from "@/lib/chains";
import {getServerEnv} from "@/lib/env";
import type {RpcOverrides} from "@/lib/models/ClinicSettings";

// `paymentChainByKey`'s four entries are each a distinct chain-const literal type (viem infers a
// slightly different `formatters`/transaction shape per chain), so a function returning "whichever
// one was requested" cannot be typed as `ReturnType<typeof createPublicClient>` without the
// specific chain's generic - every call site here only ever does chain-agnostic reads
// (`getBlockNumber`, `getBlock`, `getContractEvents`), so the generic default `PublicClient` (no
// chain type parameter) is deliberately what this module exposes; the cast below is narrowing a
// real, compatible value to that looser type, not asserting something false.
const clients = new Map<string, PublicClient>();

const ENV_RPC: Record<PaymentChainKey, keyof ReturnType<typeof getServerEnv>> = {
  ethereum: "ETHEREUM_RPC_URL",
  base: "BASE_RPC_URL",
  sepolia: "SEPOLIA_RPC_URL",
  baseSepolia: "BASE_SEPOLIA_RPC_URL",
};

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
