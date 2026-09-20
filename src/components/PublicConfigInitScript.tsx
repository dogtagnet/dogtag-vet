import "server-only";
import Script from "next/script";
import {getServerEnv} from "@/lib/env";

/**
 * Hands the browser bundle the ROAX RPC/chain id/explorer and the five protocol contract
 * addresses this server process is ACTUALLY running with, before any client module (`chains.ts`'s
 * `roax` chain object, `wagmi.ts`'s `wagmiConfig`, SetupWizard's onboarding checks, every
 * `AddressChip`'s explorer link) gets a chance to evaluate.
 *
 * Why this exists: `src/lib/env.public.ts`'s `NEXT_PUBLIC_`-prefixed env reads get inlined into
 * the JS bundle at `next build` time. A container image is built once and deployed to many
 * environments (dev/staging/prod, each with its own RPC, chain id, and contract addresses) via the
 * same Dockerfile/docker-compose.yml/Helm chart with different runtime env - values that arrive
 * after the build already happened can never reach a bundle-inlined literal. That is exactly why
 * the setup wizard used to render "Protocol addresses are not configured" on a container whose
 * addresses were correctly set in its OWN runtime env, just never at `next build` time (WP4.17
 * D2, found from `docs/DEPLOY.md`'s own accuracy check: the documented Compose/Helm quickstart
 * could never actually reach a working setup wizard).
 *
 * Reading them here instead, through `src/lib/env.ts`'s `getServerEnv()` (which parses this
 * process's actual `process.env` dynamically - a bulk/dynamic read Next's inliner cannot see, since
 * it only rewrites the literal `process.env.NEXT_PUBLIC_X` syntactic pattern), and writing them
 * onto `window` from a `beforeInteractive` script, means one built image serves every
 * environment's real protocol config correctly. Same pattern as dogtag-admin's
 * `ChainConfigInitScript` (`src/components/chain/chain-config-init-script.tsx`).
 */
export function PublicConfigInitScript() {
  const env = getServerEnv();
  const config = {
    roaxRpcUrl: env.ROAX_RPC_URL,
    roaxChainId: env.ROAX_CHAIN_ID,
    roaxExplorerUrl: env.ROAX_EXPLORER_URL,
    vetIssuerFactoryAddress: env.VET_ISSUER_FACTORY_ADDRESS ?? "",
    entityRegistryAddress: env.ENTITY_REGISTRY_ADDRESS ?? "",
    dogTagSbtAddress: env.DOGTAG_SBT_ADDRESS ?? "",
    verificationRegistryAddress: env.VERIFICATION_REGISTRY_ADDRESS ?? "",
    delegationRegistryAddress: env.DELEGATION_REGISTRY_ADDRESS ?? "",
  };

  return (
    // See the root layout's own `noFlashThemeScript` for the same beforeInteractive-in-<head>
    // reasoning (App Router root layout, not pages/_document.js).
    // eslint-disable-next-line @next/next/no-before-interactive-script-outside-document
    <Script id="public-config-init" strategy="beforeInteractive">
      {`window.__DOGTAG_VET_PUBLIC_CONFIG__=${JSON.stringify(config).replace(/</g, "\\u003c")};`}
    </Script>
  );
}
