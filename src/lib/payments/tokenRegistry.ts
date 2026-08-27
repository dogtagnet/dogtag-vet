import "server-only";
import {getServerEnv} from "@/lib/env";
import type {PaymentChainKey} from "@/lib/chains";
import type {PaymentToken} from "@/lib/models/Payment";
import {
  resolveTokenInfo,
  ALL_CHAIN_KEYS,
  ALL_TOKENS,
  DEFAULT_TOKEN_ADDRESSES,
  type TokenInfo,
  type StablecoinAddresses,
} from "@/lib/payments/tokenTable";

export type {TokenInfo};
export {ALL_CHAIN_KEYS, ALL_TOKENS};

/**
 * Env-wired token registry - the thin, `server-only` half of `tokenTable.ts`'s pure resolver (see
 * that file's doc comment for why the split exists: this half can't be imported from a unit test
 * at all, so every address/chainId fact worth testing lives in the pure half instead).
 *
 * `placeholder: true` marks a token address this repo could not source a real, canonical
 * deployment for at vendoring time (there is no official Tether-issued USDT on Base, Sepolia, or
 * Base Sepolia) - env-overridable (`TOKEN_USDT_<CHAIN>_ADDRESS`); the settings and
 * payment-creation UI surface a banner naming the env var whenever a placeholder rail is toggled
 * on, per design-system.md's "clear banners, never nagging" rule.
 */
/** A rail is still `placeholder` iff its resolved address is STILL the default synthetic one -
 * once an operator sets the env override to a real contract, this correctly stops warning. */
function isStillPlaceholder(resolvedAddress: string): boolean {
  return (
    resolvedAddress === DEFAULT_TOKEN_ADDRESSES.usdtBasePlaceholder ||
    resolvedAddress === DEFAULT_TOKEN_ADDRESSES.usdtSepoliaPlaceholder ||
    resolvedAddress === DEFAULT_TOKEN_ADDRESSES.usdtBaseSepoliaPlaceholder
  );
}

export function tokenInfo(chainKey: PaymentChainKey, token: PaymentToken): TokenInfo {
  const env = getServerEnv();
  const table: Record<PaymentChainKey, StablecoinAddresses> = {
    ethereum: {usdc: env.TOKEN_USDC_ETHEREUM_ADDRESS, usdt: env.TOKEN_USDT_ETHEREUM_ADDRESS},
    base: {usdc: env.TOKEN_USDC_BASE_ADDRESS, usdt: env.TOKEN_USDT_BASE_ADDRESS, usdtPlaceholder: isStillPlaceholder(env.TOKEN_USDT_BASE_ADDRESS)},
    sepolia: {
      usdc: env.TOKEN_USDC_SEPOLIA_ADDRESS,
      usdt: env.TOKEN_USDT_SEPOLIA_ADDRESS,
      usdtPlaceholder: isStillPlaceholder(env.TOKEN_USDT_SEPOLIA_ADDRESS),
    },
    baseSepolia: {
      usdc: env.TOKEN_USDC_BASE_SEPOLIA_ADDRESS,
      usdt: env.TOKEN_USDT_BASE_SEPOLIA_ADDRESS,
      usdtPlaceholder: isStillPlaceholder(env.TOKEN_USDT_BASE_SEPOLIA_ADDRESS),
    },
  };
  return resolveTokenInfo(chainKey, token, table[chainKey]);
}
