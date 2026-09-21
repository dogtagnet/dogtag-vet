import "server-only";
import {getServerEnv} from "@/lib/env";
import type {PaymentChainKey} from "@/lib/chains";
import type {PaymentToken} from "@/lib/models/Payment";
import {roaxChainId} from "@/lib/paymentChainRead";
import {
  resolveTokenInfo,
  ALL_CHAIN_KEYS,
  ALL_TOKENS,
  DEFAULT_TOKEN_ADDRESSES,
  tokensFor,
  type TokenInfo,
  type RoaxTokenAddresses,
} from "@/lib/payments/tokenTable";

export type {TokenInfo};
export {ALL_CHAIN_KEYS, ALL_TOKENS, tokensFor};

/**
 * Env-wired token registry - the thin, `server-only` half of `tokenTable.ts`'s pure resolver (see
 * that file's doc comment for why the split exists: this half can't be imported from a unit test
 * at all, so every address/chainId fact worth testing lives in the pure half instead).
 *
 * `placeholder: true` marks the RUSD address this repo cannot source a real, canonical deployment
 * for at vendoring time (there is no way for THIS repo to know a per-deployment dev stablecoin's
 * address in advance - it is deployed by the workstation runbook, then recorded here) - env-
 * overridable (`TOKEN_RUSD_ROAX_ADDRESS`), and the settings and payment-creation UI surface a
 * banner naming the env var whenever a placeholder rail is toggled on, per design-system.md's
 * "clear banners, never nagging" rule.
 */
/** A rail is still `placeholder` iff its resolved address is STILL the default synthetic one -
 * once an operator sets the env override to the real deployed RUSD contract, this correctly stops
 * warning. */
function isStillPlaceholder(resolvedAddress: string): boolean {
  return resolvedAddress === DEFAULT_TOKEN_ADDRESSES.rusdRoaxPlaceholder;
}

export function tokenInfo(chainKey: PaymentChainKey, token: PaymentToken): TokenInfo {
  const env = getServerEnv();
  const table: Record<PaymentChainKey, RoaxTokenAddresses> = {
    roax: {rusd: env.TOKEN_RUSD_ROAX_ADDRESS, rusdPlaceholder: isStillPlaceholder(env.TOKEN_RUSD_ROAX_ADDRESS)},
  };
  return resolveTokenInfo(chainKey, token, table[chainKey], roaxChainId());
}
