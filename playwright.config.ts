import {defineConfig, devices} from "@playwright/test";
import {E2E_MONGO_URI} from "./e2e/mongo-fixture";
import {RPC_STUB_URL} from "./e2e/rpcStub";

// Overridable so a copy of this checkout synced elsewhere (to run its own dev server without
// colliding with a `next dev`/`next start` already bound to the default port from THIS checkout)
// can run the suite on a different one. Defaults to 4210 unchanged for every normal
// `pnpm test:e2e` run.
const PORT = Number(process.env.E2E_WEB_PORT ?? 4210);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {...devices["Desktop Chrome"]},
    },
  ],
  webServer: {
    command: `pnpm dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DEV_LOGIN: "1",
      MONGODB_URI: E2E_MONGO_URI,
      PUBLIC_BASE_URL: `http://localhost:${PORT}`,
      AUTH_SECRET: "e2e-test-secret-not-for-production-use",
      AUTH_TRUST_HOST: "1",
      // wallet-registration.spec.ts's session creation reads the current block number, and
      // WP4.4's mobile-booking tiers read profileRoot/rootIssuer/isValid - all against
      // `rpcStub.ts`'s local, deterministic, scriptable stub (`global-setup.ts` starts it for the
      // whole run) rather than a real devnet RPC: offline, and drivable per-test for tiers a real
      // chain has no practical way to put into a specific state on demand (a foreign-clone tag, an
      // unreadable-chain retry). ROAX_EXPLORER_URL stays a real (non-secret) URL - only used to
      // build display links, never actually fetched.
      ROAX_RPC_URL: RPC_STUB_URL,
      ROAX_CHAIN_ID: "135",
      ROAX_EXPLORER_URL: "https://explorer.roax.net",
      NEXT_PUBLIC_ROAX_RPC_URL: RPC_STUB_URL,
      NEXT_PUBLIC_ROAX_CHAIN_ID: "135",
      NEXT_PUBLIC_ROAX_EXPLORER_URL: "https://explorer.roax.net",
      VET_ISSUER_FACTORY_ADDRESS: "0x1bd279d3c9fc85eb3e4d304ee890435b6a5ca4cc",
      ENTITY_REGISTRY_ADDRESS: "0x9b15a2df4e38547cbbbd635a4cd4531355bb4247",
      DOGTAG_SBT_ADDRESS: "0x276101555b2cd92be0fb85ff908e02281d6a3cf9",
      VERIFICATION_REGISTRY_ADDRESS: "0x41e96ad9e93ecb722e69aec6c0d4b4f15040ddd0",
      NEXT_PUBLIC_VET_ISSUER_FACTORY_ADDRESS: "0x1bd279d3c9fc85eb3e4d304ee890435b6a5ca4cc",
      NEXT_PUBLIC_ENTITY_REGISTRY_ADDRESS: "0x9b15a2df4e38547cbbbd635a4cd4531355bb4247",
      NEXT_PUBLIC_DOGTAG_SBT_ADDRESS: "0x276101555b2cd92be0fb85ff908e02281d6a3cf9",
      NEXT_PUBLIC_VERIFICATION_REGISTRY_ADDRESS: "0x41e96ad9e93ecb722e69aec6c0d4b4f15040ddd0",
    },
  },
});
