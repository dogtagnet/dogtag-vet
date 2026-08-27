import {defineChain} from "viem";
import {base, baseSepolia, mainnet, sepolia} from "viem/chains";
import {publicEnv} from "@/lib/env.public";

/**
 * ROAX - the identity-protocol chain (EntityRegistry, VetIssuerFactory, VetIssuer clones,
 * DogTagSBTConsent, VerificationRegistryConsent all live here). Legacy transaction type only:
 * every chain write against ROAX in this repo must go through a single write helper that forces
 * `type: "legacy"` (see src/lib/chainWrite.ts, wired in a later stage) rather than letting each
 * call site decide independently.
 */
export const roax = defineChain({
  id: publicEnv.roaxChainId,
  name: "ROAX",
  nativeCurrency: {name: "PLASMA", symbol: "PLASMA", decimals: 18},
  rpcUrls: {
    default: {http: [publicEnv.roaxRpcUrl]},
  },
  blockExplorers: {
    default: {name: "ROAX Explorer", url: publicEnv.roaxExplorerUrl},
  },
  testnet: true,
});

/** Payment-rail chains, per wp4-vet.md's fixed set (Ethereum, Base, Sepolia, Base Sepolia). RPC
 * URLs are overridden from env/settings; these are the public-default fallbacks. */
export const paymentChains = [
  {...mainnet, rpcUrls: {...mainnet.rpcUrls, default: {http: [publicEnv.ethereumRpcUrl]}}},
  {...base, rpcUrls: {...base.rpcUrls, default: {http: [publicEnv.baseRpcUrl]}}},
  {...sepolia, rpcUrls: {...sepolia.rpcUrls, default: {http: [publicEnv.sepoliaRpcUrl]}}},
  {...baseSepolia, rpcUrls: {...baseSepolia.rpcUrls, default: {http: [publicEnv.baseSepoliaRpcUrl]}}},
] as const;

export type PaymentChainKey = "ethereum" | "base" | "sepolia" | "baseSepolia";

export const paymentChainByKey: Record<PaymentChainKey, (typeof paymentChains)[number]> = {
  ethereum: paymentChains[0],
  base: paymentChains[1],
  sepolia: paymentChains[2],
  baseSepolia: paymentChains[3],
};

export const paymentChainKeyByChainId: Record<number, PaymentChainKey> = {
  [mainnet.id]: "ethereum",
  [base.id]: "base",
  [sepolia.id]: "sepolia",
  [baseSepolia.id]: "baseSepolia",
};
