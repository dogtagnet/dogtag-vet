/**
 * Client-safe environment values. Next.js inlines `process.env.NEXT_PUBLIC_*` at build time only
 * when the reference is a literal property access - so every build-time-fallback value below is
 * read directly rather than through a dynamic lookup, and this file may be imported from client
 * components.
 *
 * `roaxRpcUrl`/`roaxChainId`/`roaxExplorerUrl` and the five protocol contract addresses
 * (`vetIssuerFactoryAddress`, `entityRegistryAddress`, `dogTagSbtAddress`,
 * `verificationRegistryAddress`, `delegationRegistryAddress`) are RUNTIME values, not build-time
 * ones: a single container image is built once and deployed to many environments (dev/staging/
 * prod, each with its own RPC, chain id, and contract addresses), and a `NEXT_PUBLIC_*` value read
 * as a literal property access gets INLINED into the JS bundle at `next build` time - a value that
 * arrives later, from that container's own runtime env, can never reach a bundle-inlined literal
 * (WP4.17 D2).
 *
 * `PublicConfigInitScript` (`src/components/PublicConfigInitScript.tsx`), rendered in the root
 * layout, reads this server process's REAL env on every request (through `src/lib/env.ts`'s
 * dynamic `process.env` parse, which Next's build-time inlining cannot see - it only rewrites the
 * literal `process.env.NEXT_PUBLIC_X` pattern, never a bulk/dynamic read) and writes those eight
 * values onto `window.__DOGTAG_VET_PUBLIC_CONFIG__` from a `beforeInteractive` script, before any
 * other client module (this one included) ever evaluates. The eight fields below prefer that
 * injected global - the real runtime value for this deployment - over the build-time-inlined
 * `NEXT_PUBLIC_*` fallback, which remains only for contexts with no injected script at all (a unit
 * test importing this module directly) and for this server process's own brief pre-hydration
 * render pass (`window` is never defined in Node.js, so the injected branch is always empty there
 * - see `@/lib/usePublicEnv`'s `usePublicEnv` hook for the one case that makes reading `publicEnv`
 * directly, at render time, unsafe). This mirrors dogtag-admin's `ChainConfigInitScript`/
 * `src/lib/chain/roax.ts` pattern exactly.
 *
 * This module itself stays hook-free and import-safe from EITHER side (server route handlers -
 * `chains.ts`'s `roax` chain object is used for server-side chain reads too - or client
 * components): `usePublicEnv` lives in the separate `@/lib/usePublicEnv`, marked `"use client"`,
 * specifically so importing this file never pulls a React hook into a server-only import chain.
 *
 * Every injected field is validated independently before use (see the `*Or` helpers below) - a
 * malformed or missing field on `window.__DOGTAG_VET_PUBLIC_CONFIG__` falls back to the build-time
 * value for THAT field alone, never throws, and never corrupts a sibling field.
 *
 * Known gap, disclosed rather than silently left: `roaxExplorerUrl` reaches rendered `<a href>`
 * output through `chains.ts`'s `roax.blockExplorers` -> `explorer.ts`'s `explorerUrl()` ->
 * `AddressChip`/`HashCell` (via `MonoValue`) for every `chain="roax"` chip - so a deployment whose
 * runtime explorer URL differs from its build-time fallback gets an attribute-level hydration
 * difference on those links (React corrects it after hydration; this is not the structural,
 * whole-subtree mismatch `usePublicEnv` exists to prevent). Not fixed the way `SetupWizard` was:
 * `AddressChip`/`HashCell` also render from genuine Server Components (e.g.
 * `src/app/(app)/settings/page.tsx`, `src/app/pay/[id]/page.tsx`), where a hook is structurally
 * unavailable, and having this module prefer a dynamic server-side env read when `window` is
 * undefined would make `publicEnvServerFallback` stop matching what the server actually rendered -
 * reintroducing the exact mismatch `usePublicEnv`'s three-argument `useSyncExternalStore` was added
 * to kill, for every OTHER field, just to fix this one. `roax.id`/`roax.rpcUrls` carry the same
 * theoretical divergence but never reach rendered output this way: every render that shows `chain
 * {roax.id}` as text is itself gated behind client-only state (`isConnected`/`wrongNetwork` from
 * wagmi, `qr && session` from a fetch) that is always false on both the server pass and the
 * client's first hydration pass, so the branch that would show a stale value never paints first.
 */

interface InjectedPublicConfig {
  roaxRpcUrl?: unknown;
  roaxChainId?: unknown;
  roaxExplorerUrl?: unknown;
  vetIssuerFactoryAddress?: unknown;
  entityRegistryAddress?: unknown;
  dogTagSbtAddress?: unknown;
  verificationRegistryAddress?: unknown;
  delegationRegistryAddress?: unknown;
}

declare global {
  interface Window {
    /** Set by `PublicConfigInitScript` - see this module's own doc comment above for the full
     * rationale. */
    __DOGTAG_VET_PUBLIC_CONFIG__?: InjectedPublicConfig;
  }
}

function readInjectedConfig(): InjectedPublicConfig {
  if (typeof window === "undefined") return {};
  const raw = window.__DOGTAG_VET_PUBLIC_CONFIG__;
  return raw && typeof raw === "object" ? raw : {};
}

/** A non-empty string, or `fallback` if `value` is not one - `roaxRpcUrl`/`roaxExplorerUrl`'s
 * validator. */
function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** A positive integer, or `fallback` if `value` is not one - `roaxChainId`'s validator. */
function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** `""` (the existing not-yet-configured sentinel every address field already uses) or a
 * well-formed `0x`-prefixed 40-hex-char address - anything else falls back. Every one of these
 * five addresses is public on-chain data, never a secret. */
function addressOr(value: unknown, fallback: string): string {
  if (value === "") return "";
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value : fallback;
}

function computePublicEnv(injected: InjectedPublicConfig) {
  return {
    roaxRpcUrl: stringOr(injected.roaxRpcUrl, process.env.NEXT_PUBLIC_ROAX_RPC_URL ?? "https://roax-testnet-rpc.dogtag.example/rpc"),
    roaxChainId: positiveIntOr(injected.roaxChainId, Number(process.env.NEXT_PUBLIC_ROAX_CHAIN_ID ?? "135")),
    roaxExplorerUrl: stringOr(injected.roaxExplorerUrl, process.env.NEXT_PUBLIC_ROAX_EXPLORER_URL ?? "https://roax-testnet.blockscout.example"),

    // Protocol contract addresses - not secret (every one of them is public on chain), so these are
    // exposed to the client directly rather than round-tripped through an API route just so the
    // setup wizard's wagmi reads can address them.
    vetIssuerFactoryAddress: addressOr(injected.vetIssuerFactoryAddress, process.env.NEXT_PUBLIC_VET_ISSUER_FACTORY_ADDRESS ?? ""),
    entityRegistryAddress: addressOr(injected.entityRegistryAddress, process.env.NEXT_PUBLIC_ENTITY_REGISTRY_ADDRESS ?? ""),
    dogTagSbtAddress: addressOr(injected.dogTagSbtAddress, process.env.NEXT_PUBLIC_DOGTAG_SBT_ADDRESS ?? ""),
    verificationRegistryAddress: addressOr(injected.verificationRegistryAddress, process.env.NEXT_PUBLIC_VERIFICATION_REGISTRY_ADDRESS ?? ""),
    delegationRegistryAddress: addressOr(injected.delegationRegistryAddress, process.env.NEXT_PUBLIC_DELEGATION_REGISTRY_ADDRESS ?? ""),

    // DEV/TEST ONLY (mirrors .env.example's DEV_LOGIN convention) - a wallet address here gates an
    // extra `mock` wagmi connector (src/lib/wagmi.ts) plus its matching auto-connect effect
    // (src/components/Providers.tsx), letting Playwright drive every wallet-gated surface
    // (TagIssueWizard, TagsTable, VerifySessionPanel, SetupWizard) with no browser extension. Blank
    // by default and NEVER set in a real deployment - unset, wagmiConfig's connector list and
    // Providers' render tree are byte-for-byte what they were before this gate existed. Always a
    // build-time-only value, deliberately never part of the runtime-injected config above - this
    // gate exists only for a checkout's own local/CI build, never a real deployment's runtime env.
    e2eMockWalletAddress: process.env.NEXT_PUBLIC_E2E_MOCK_WALLET_ADDRESS ?? "",
  };
}

export type PublicEnv = ReturnType<typeof computePublicEnv>;

export const publicEnv: PublicEnv = computePublicEnv(readInjectedConfig());

/** The build-time-fallback-only snapshot - identical to what THIS SERVER PROCESS always computes
 * for `publicEnv` (it never has `window`) - exported so `@/lib/usePublicEnv`'s `usePublicEnv` hook
 * can hand it to `useSyncExternalStore` as the value the CLIENT's first (hydrating) render must
 * also produce. Never import this for any other purpose; every ordinary read should use
 * `publicEnv` (module scope) or `usePublicEnv()` (inside a component that branches its own
 * rendered output shape on a runtime-injected field - see that hook's own doc comment). */
export const publicEnvServerFallback: PublicEnv = computePublicEnv({});
