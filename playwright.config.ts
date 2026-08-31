import {defineConfig, devices} from "@playwright/test";
import {E2E_MONGO_URI} from "./e2e/mongo-fixture";

const PORT = 4210;

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
      // wallet-registration.spec.ts's session creation makes a real (read-only - this flow never
      // writes on chain) network round trip for the current block number; a fresh checkout has no
      // .env.local, so without these the suite cannot pass at all. Non-secret: a public ROAX
      // devnet RPC/explorer and this clinic's own already-deployed contract addresses, not keys.
      ROAX_RPC_URL: "https://devrpc.roax.net",
      ROAX_CHAIN_ID: "135",
      ROAX_EXPLORER_URL: "https://explorer.roax.net",
      NEXT_PUBLIC_ROAX_RPC_URL: "https://devrpc.roax.net",
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
