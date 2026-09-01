import {http, createConfig} from "wagmi";
import {metaMask, mock} from "wagmi/connectors";
import {roax} from "@/lib/chains";
import {publicEnv} from "@/lib/env.public";

/**
 * DEV/TEST ONLY gate - see `env.public.ts`'s own doc comment on `e2eMockWalletAddress` for the
 * full rationale. When set, `mock` (wagmi's OWN test connector, exported from its own installed
 * `wagmi/connectors` - not a hand-rolled shim) is registered alongside the real `metaMask()`
 * connector, so Playwright can drive `TagIssueWizard`/`TagsTable`/`VerifySessionPanel`/
 * `SetupWizard` - every one of which renders nothing past a "connect your wallet" gate until
 * `useAccount().isConnected` - without a real browser extension. `Providers.tsx`'s matching
 * auto-connect effect looks this connector up by `id === "mock"` from `useConnect()`'s own
 * `connectors` list rather than reaching for a second instance of it constructed here, so there is
 * only ever one `mock` connector object per page load, wired into `wagmiConfig` exactly once. Left
 * unset (the default, and the only value a real `.env` should ever carry), the array below is
 * `[metaMask()]` - byte-for-byte what this file was before this gate existed.
 */
const mockWalletAddress = publicEnv.e2eMockWalletAddress;
// `mock`'s own `accounts` parameter is a non-empty TUPLE type (`readonly [Address, ...Address[]]`),
// not a plain array - an explicitly-typed local like this (rather than an inline array literal at
// the call site) is what reliably gets TypeScript to accept a one-element list here.
const mockWalletAccounts: readonly [`0x${string}`, ...`0x${string}`[]] | undefined = mockWalletAddress
  ? [mockWalletAddress as `0x${string}`]
  : undefined;

export const wagmiConfig = createConfig({
  chains: [roax],
  connectors: [
    metaMask(),
    ...(mockWalletAccounts ? [mock({accounts: mockWalletAccounts})] : []),
  ],
  transports: {
    [roax.id]: http(),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
