import type {PaymentChainKey} from "@/lib/chains";
import type {PaymentToken} from "@/lib/models/Payment";

/**
 * Pure token-registry logic, deliberately split out of `tokenRegistry.ts` (which reads live env
 * vars and is marked `server-only`) so this half - and its default addresses - can be imported
 * directly by unit tests (`tests/unit/eip681.test.ts`) with no env, no `server-only` guard, and no
 * risk of a test silently drifting from what production actually defaults to (`env.ts`'s zod
 * schema defaults ARE these same constants, not independently retyped literals).
 *
 * `placeholder: true` on the three testnet USDT slots marks a deliberately inert, obviously-
 * synthetic address (`0x999...999`) used because there is no canonical Tether-issued USDT
 * deployment on Base, Sepolia, or Base Sepolia to point to - see `tokenRegistry.ts`'s doc comment
 * for the operator-facing side of this (env override, settings-page banner).
 */
export const DEFAULT_TOKEN_ADDRESSES = {
  usdcEthereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  usdcBase: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  usdcSepolia: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  usdcBaseSepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  usdtEthereum: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  usdtBasePlaceholder: `0x${"9".repeat(40)}`,
  usdtSepoliaPlaceholder: `0x${"9".repeat(40)}`,
  usdtBaseSepoliaPlaceholder: `0x${"9".repeat(40)}`,
} as const;

export interface TokenInfo {
  chainId: number;
  address?: `0x${string}`; // absent = native asset (ETH)
  decimals: number;
  placeholder?: boolean;
}

const NATIVE_DECIMALS = 18;
const STABLECOIN_DECIMALS = 6; // USDC and USDT both use 6 decimals on every chain this app targets

export interface StablecoinAddresses {
  usdc: string;
  usdt: string;
  usdtPlaceholder?: boolean;
}

/** `chainId`s are the real, literal numeric ids EIP-681 URIs embed - 1 (Ethereum), 8453 (Base),
 * 11155111 (Sepolia), 84532 (Base Sepolia) - duplicated here as plain numbers (not re-derived from
 * `viem/chains`) specifically so a test asserting them is checking against a fixed fact, not
 * whichever value `paymentChainByKey` happens to resolve to today. */
const CHAIN_IDS: Record<PaymentChainKey, number> = {
  ethereum: 1,
  base: 8453,
  sepolia: 11155111,
  baseSepolia: 84532,
};

export function defaultAddressesFor(chainKey: PaymentChainKey): StablecoinAddresses {
  switch (chainKey) {
    case "ethereum":
      return {usdc: DEFAULT_TOKEN_ADDRESSES.usdcEthereum, usdt: DEFAULT_TOKEN_ADDRESSES.usdtEthereum};
    case "base":
      return {usdc: DEFAULT_TOKEN_ADDRESSES.usdcBase, usdt: DEFAULT_TOKEN_ADDRESSES.usdtBasePlaceholder, usdtPlaceholder: true};
    case "sepolia":
      return {usdc: DEFAULT_TOKEN_ADDRESSES.usdcSepolia, usdt: DEFAULT_TOKEN_ADDRESSES.usdtSepoliaPlaceholder, usdtPlaceholder: true};
    case "baseSepolia":
      return {
        usdc: DEFAULT_TOKEN_ADDRESSES.usdcBaseSepolia,
        usdt: DEFAULT_TOKEN_ADDRESSES.usdtBaseSepoliaPlaceholder,
        usdtPlaceholder: true,
      };
  }
}

/** Pure resolver: given the stablecoin addresses for `chainKey` (production passes env-resolved
 * ones; tests pass `defaultAddressesFor` directly), returns the full `TokenInfo` for `token`. */
export function resolveTokenInfo(chainKey: PaymentChainKey, token: PaymentToken, addresses: StablecoinAddresses): TokenInfo {
  const chainId = CHAIN_IDS[chainKey];
  if (token === "ETH") return {chainId, decimals: NATIVE_DECIMALS};
  if (token === "USDC") return {chainId, address: addresses.usdc as `0x${string}`, decimals: STABLECOIN_DECIMALS};
  return {
    chainId,
    address: addresses.usdt as `0x${string}`,
    decimals: STABLECOIN_DECIMALS,
    placeholder: addresses.usdtPlaceholder,
  };
}

export const ALL_CHAIN_KEYS: PaymentChainKey[] = ["ethereum", "base", "sepolia", "baseSepolia"];
export const ALL_TOKENS: PaymentToken[] = ["ETH", "USDC", "USDT"];
