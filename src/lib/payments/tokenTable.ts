import type {PaymentChainKey} from "@/lib/chains";
import type {PaymentToken} from "@/lib/models/Payment";

/**
 * Pure token-registry logic, deliberately split out of `tokenRegistry.ts` (which reads live env
 * vars and is marked `server-only`) so this half - and its default address - can be imported
 * directly by unit tests (`tests/unit/eip681.test.ts`) with no env, no `server-only` guard, and no
 * risk of a test silently drifting from what production actually defaults to (`env.ts`'s zod
 * schema default IS this same constant, not an independently retyped literal).
 *
 * `placeholder: true` on the RUSD slot marks a deliberately inert, obviously-synthetic address
 * (`0x999...999`) used because RUSD is a fresh, per-deployment dev stablecoin (`docs/DEV-TOKENS.md`)
 * with no canonical address this repo could ever bake in - the exact same "no real deployment to
 * point to" situation the old testnet USDT slots were in before WP4.18 removed them, reusing that
 * precedent rather than inventing a new one. See `tokenRegistry.ts`'s doc comment for the
 * operator-facing side of this (env override via `TOKEN_RUSD_ROAX_ADDRESS`, the Settings/
 * payment-creation UI banner).
 */
export const DEFAULT_TOKEN_ADDRESSES = {
  rusdRoaxPlaceholder: `0x${"9".repeat(40)}`,
} as const;

export interface TokenInfo {
  chainId: number;
  address?: `0x${string}`; // absent = native asset (PLASMA)
  decimals: number;
  placeholder?: boolean;
}

const NATIVE_DECIMALS = 18; // PLASMA, ROAX's native asset
const RUSD_DECIMALS = 6; // matches USDC/USDT's convention, per wp4.18-roax-payments.md section 6

export interface RoaxTokenAddresses {
  rusd: string;
  rusdPlaceholder?: boolean;
}

/** Per-chain default token addresses. A `switch` over `PaymentChainKey`, not a bare object, so a
 * future second chain (wp4.18 section 7: "a future chain is a config and registry addition, never
 * a rewrite") is a new `case`, and the compiler flags every place that still assumed one chain. */
export function defaultAddressesFor(chainKey: PaymentChainKey): RoaxTokenAddresses {
  switch (chainKey) {
    case "roax":
      return {rusd: DEFAULT_TOKEN_ADDRESSES.rusdRoaxPlaceholder, rusdPlaceholder: true};
  }
}

/** Per-chain token list - `PaymentForm.tsx` and `GET /api/payments/rails` iterate this INSTEAD of
 * a blind `ALL_CHAIN_KEYS x ALL_TOKENS` cross product, so a chain only ever offers the assets it
 * actually declares (wp4.18 section 2: "this removes the cross product that would otherwise
 * generate nonsense rails such as Ethereum-PLASMA"). */
const TOKENS_BY_CHAIN: Record<PaymentChainKey, readonly PaymentToken[]> = {
  roax: ["PLASMA", "RUSD"],
};

export function tokensFor(chainKey: PaymentChainKey): readonly PaymentToken[] {
  return TOKENS_BY_CHAIN[chainKey];
}

/** Pure resolver: given the token addresses for `chainKey` (production passes env-resolved ones;
 * tests pass `defaultAddressesFor` directly) and the chain's numeric id (resolved by the caller -
 * see this module's own doc comment for why that stays a parameter rather than a literal baked in
 * here, unlike the four now-removed public chains' fixed ids), returns the full `TokenInfo` for
 * `token`. */
export function resolveTokenInfo(chainKey: PaymentChainKey, token: PaymentToken, addresses: RoaxTokenAddresses, chainId: number): TokenInfo {
  if (token === "PLASMA") return {chainId, decimals: NATIVE_DECIMALS};
  return {
    chainId,
    address: addresses.rusd as `0x${string}`,
    decimals: RUSD_DECIMALS,
    placeholder: addresses.rusdPlaceholder,
  };
}

export const ALL_CHAIN_KEYS: PaymentChainKey[] = ["roax"];
export const ALL_TOKENS: PaymentToken[] = ["PLASMA", "RUSD"];
