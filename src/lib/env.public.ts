/**
 * Client-safe environment values. Next.js inlines `process.env.NEXT_PUBLIC_*` at build time only
 * when the reference is a literal property access - so every value below is read directly rather
 * than through a dynamic lookup, and this file may be imported from client components.
 */
export const publicEnv = {
  roaxRpcUrl: process.env.NEXT_PUBLIC_ROAX_RPC_URL ?? "https://roax-testnet-rpc.dogtag.example/rpc",
  roaxChainId: Number(process.env.NEXT_PUBLIC_ROAX_CHAIN_ID ?? "135"),
  roaxExplorerUrl: process.env.NEXT_PUBLIC_ROAX_EXPLORER_URL ?? "https://roax-testnet.blockscout.example",
  ethereumRpcUrl: process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
  baseRpcUrl: process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://base-rpc.publicnode.com",
  sepoliaRpcUrl: process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
  baseSepoliaRpcUrl:
    process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com",

  // Protocol contract addresses - not secret (every one of them is public on chain), so these are
  // exposed to the client directly rather than round-tripped through an API route just so the
  // setup wizard's wagmi reads can address them.
  vetIssuerFactoryAddress: process.env.NEXT_PUBLIC_VET_ISSUER_FACTORY_ADDRESS ?? "",
  entityRegistryAddress: process.env.NEXT_PUBLIC_ENTITY_REGISTRY_ADDRESS ?? "",
  dogTagSbtAddress: process.env.NEXT_PUBLIC_DOGTAG_SBT_ADDRESS ?? "",
  verificationRegistryAddress: process.env.NEXT_PUBLIC_VERIFICATION_REGISTRY_ADDRESS ?? "",

  // DEV/TEST ONLY (mirrors .env.example's DEV_LOGIN convention) - a wallet address here gates an
  // extra `mock` wagmi connector (src/lib/wagmi.ts) plus its matching auto-connect effect
  // (src/components/Providers.tsx), letting Playwright drive every wallet-gated surface
  // (TagIssueWizard, TagsTable, VerifySessionPanel, SetupWizard) with no browser extension. Blank
  // by default and NEVER set in a real deployment - unset, wagmiConfig's connector list and
  // Providers' render tree are byte-for-byte what they were before this gate existed.
  e2eMockWalletAddress: process.env.NEXT_PUBLIC_E2E_MOCK_WALLET_ADDRESS ?? "",
};
