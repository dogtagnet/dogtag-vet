import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

/**
 * `src/lib/env.public.ts`'s reader (WP4.17 D2 = B9 - runtime public config). `publicEnv` is
 * computed once at module scope, so each scenario below needs its own fresh module instance
 * (`vi.resetModules()` + a dynamic `import()`), exactly like `tests/unit/db.test.ts`'s pattern for
 * the same reason.
 */

const NEXT_PUBLIC_KEYS = [
  "NEXT_PUBLIC_ROAX_RPC_URL",
  "NEXT_PUBLIC_ROAX_CHAIN_ID",
  "NEXT_PUBLIC_ROAX_EXPLORER_URL",
  "NEXT_PUBLIC_VET_ISSUER_FACTORY_ADDRESS",
  "NEXT_PUBLIC_ENTITY_REGISTRY_ADDRESS",
  "NEXT_PUBLIC_DOGTAG_SBT_ADDRESS",
  "NEXT_PUBLIC_VERIFICATION_REGISTRY_ADDRESS",
  "NEXT_PUBLIC_DELEGATION_REGISTRY_ADDRESS",
] as const;

const REAL_FACTORY_ADDRESS = "0x1bd279d3c9fc85eb3e4d304ee890435b6a5ca4cc";
const INJECTED_FACTORY_ADDRESS = "0x9b15a2df4e38547cbbbd635a4cd4531355bb4247";

describe("publicEnv", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of NEXT_PUBLIC_KEYS) delete process.env[key];
    delete (globalThis as {window?: unknown}).window;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of NEXT_PUBLIC_KEYS) delete process.env[key];
    delete (globalThis as {window?: unknown}).window;
  });

  it("falls back to the built-in default with no injected script and no NEXT_PUBLIC_ env", async () => {
    const {publicEnv} = await import("@/lib/env.public");
    expect(publicEnv.roaxRpcUrl).toBe("https://roax-testnet-rpc.dogtag.example/rpc");
    expect(publicEnv.roaxChainId).toBe(135);
    expect(publicEnv.roaxExplorerUrl).toBe("https://roax-testnet.blockscout.example");
    expect(publicEnv.vetIssuerFactoryAddress).toBe("");
    expect(publicEnv.delegationRegistryAddress).toBe("");
  });

  it("falls back to the build-time NEXT_PUBLIC_ value with no injected script", async () => {
    process.env.NEXT_PUBLIC_ROAX_RPC_URL = "https://build-time-rpc.example/rpc";
    process.env.NEXT_PUBLIC_ROAX_CHAIN_ID = "999";
    process.env.NEXT_PUBLIC_VET_ISSUER_FACTORY_ADDRESS = REAL_FACTORY_ADDRESS;

    const {publicEnv} = await import("@/lib/env.public");
    expect(publicEnv.roaxRpcUrl).toBe("https://build-time-rpc.example/rpc");
    expect(publicEnv.roaxChainId).toBe(999);
    expect(publicEnv.vetIssuerFactoryAddress).toBe(REAL_FACTORY_ADDRESS);
  });

  it("prefers the injected runtime config over the build-time NEXT_PUBLIC_ value", async () => {
    process.env.NEXT_PUBLIC_ROAX_RPC_URL = "https://build-time-rpc.example/rpc";
    process.env.NEXT_PUBLIC_VET_ISSUER_FACTORY_ADDRESS = REAL_FACTORY_ADDRESS;
    (globalThis as {window?: unknown}).window = {
      __DOGTAG_VET_PUBLIC_CONFIG__: {
        roaxRpcUrl: "https://runtime-rpc.example/rpc",
        roaxChainId: 135,
        roaxExplorerUrl: "https://runtime-explorer.example",
        vetIssuerFactoryAddress: INJECTED_FACTORY_ADDRESS,
        entityRegistryAddress: INJECTED_FACTORY_ADDRESS,
        dogTagSbtAddress: INJECTED_FACTORY_ADDRESS,
        verificationRegistryAddress: INJECTED_FACTORY_ADDRESS,
        delegationRegistryAddress: INJECTED_FACTORY_ADDRESS,
      },
    };

    const {publicEnv} = await import("@/lib/env.public");
    expect(publicEnv.roaxRpcUrl).toBe("https://runtime-rpc.example/rpc");
    expect(publicEnv.vetIssuerFactoryAddress).toBe(INJECTED_FACTORY_ADDRESS);
    expect(publicEnv.delegationRegistryAddress).toBe(INJECTED_FACTORY_ADDRESS);
  });

  it("an injected empty address wins over a non-empty build-time address - runtime env is authoritative even when it says 'not configured'", async () => {
    // Not a bug: an operator who unsets an address in the container's real env (or has not set it
    // yet) must see THAT reflected in the running app, never a stale non-empty value left over
    // from whatever happened to be in the build environment.
    process.env.NEXT_PUBLIC_VET_ISSUER_FACTORY_ADDRESS = REAL_FACTORY_ADDRESS;
    (globalThis as {window?: unknown}).window = {
      __DOGTAG_VET_PUBLIC_CONFIG__: {vetIssuerFactoryAddress: ""},
    };

    const {publicEnv} = await import("@/lib/env.public");
    expect(publicEnv.vetIssuerFactoryAddress).toBe("");
  });

  it("rejects a malformed injected field and falls back to the build-time value for THAT field only, leaving siblings untouched", async () => {
    process.env.NEXT_PUBLIC_ROAX_RPC_URL = "https://build-time-rpc.example/rpc";
    process.env.NEXT_PUBLIC_ROAX_CHAIN_ID = "135";
    process.env.NEXT_PUBLIC_VET_ISSUER_FACTORY_ADDRESS = REAL_FACTORY_ADDRESS;
    (globalThis as {window?: unknown}).window = {
      __DOGTAG_VET_PUBLIC_CONFIG__: {
        roaxRpcUrl: 12345, // wrong type
        roaxChainId: "not-a-number", // wrong type
        vetIssuerFactoryAddress: "not-an-address", // wrong shape
        entityRegistryAddress: INJECTED_FACTORY_ADDRESS, // well-formed - must NOT be affected
      },
    };

    const {publicEnv} = await import("@/lib/env.public");
    expect(publicEnv.roaxRpcUrl).toBe("https://build-time-rpc.example/rpc");
    expect(publicEnv.roaxChainId).toBe(135);
    expect(publicEnv.vetIssuerFactoryAddress).toBe(REAL_FACTORY_ADDRESS);
    expect(publicEnv.entityRegistryAddress).toBe(INJECTED_FACTORY_ADDRESS);
  });

  it("rejects a non-positive or non-integer injected chain id", async () => {
    (globalThis as {window?: unknown}).window = {
      __DOGTAG_VET_PUBLIC_CONFIG__: {roaxChainId: -1},
    };
    const {publicEnv: negative} = await import("@/lib/env.public");
    expect(negative.roaxChainId).toBe(135);

    vi.resetModules();
    (globalThis as {window?: unknown}).window = {
      __DOGTAG_VET_PUBLIC_CONFIG__: {roaxChainId: 135.5},
    };
    const {publicEnv: fractional} = await import("@/lib/env.public");
    expect(fractional.roaxChainId).toBe(135);
  });

  it("treats a non-object injected global the same as no injected script at all", async () => {
    (globalThis as {window?: unknown}).window = {__DOGTAG_VET_PUBLIC_CONFIG__: "garbage"};
    const {publicEnv} = await import("@/lib/env.public");
    expect(publicEnv.roaxRpcUrl).toBe("https://roax-testnet-rpc.dogtag.example/rpc");
  });

  it("never reads the DEV/TEST-only mock wallet address from the injected config, even if present", async () => {
    process.env.NEXT_PUBLIC_E2E_MOCK_WALLET_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb9226";
    (globalThis as {window?: unknown}).window = {
      __DOGTAG_VET_PUBLIC_CONFIG__: {vetIssuerFactoryAddress: INJECTED_FACTORY_ADDRESS},
    };
    const {publicEnv} = await import("@/lib/env.public");
    expect(publicEnv.vetIssuerFactoryAddress).toBe(INJECTED_FACTORY_ADDRESS);
    expect(publicEnv.e2eMockWalletAddress).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb9226");
  });
});
