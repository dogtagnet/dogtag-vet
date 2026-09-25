import {afterEach, describe, expect, it, vi} from "vitest";
import type {PublicClient} from "viem";

/**
 * 2026-09-25 workstation incident investigation - "find the browser-side trigger if you can"
 * (the fail-open path only fires when `estimateContractGas` throws, or there is no public client
 * at all; `legacyTxWithGas`'s own gas-floor fix makes either outcome harmless, but this file tries
 * to name the actual mechanism per Kenneth's reproduce-first rule). Three candidate shapes named
 * by the incident brief, each checked directly:
 *
 * (1) the `account` field leaking into the estimate - DISPROVEN by inspection AND by a passing
 *     test: `legacyTxWithGas` builds a NEW object for `estimateContractGas` with exactly
 *     `{address, abi, functionName, args, account}` (`src/lib/chainWrite.ts`), and
 *     `tests/unit/chainWriteGas.integration.test.ts` already sends that exact shape (`account`
 *     included) through a REAL viem `PublicClient` over a REAL HTTP round trip to `e2e/rpcStub.ts`
 *     and succeeds every time - an `account` field on its own does not make a real RPC stub (or,
 *     by the same code path, a real node) reject the call.
 * (2) `type: "legacy"` leaking into the estimate call - DISPROVEN by inspection: `legacyTxWithGas`
 *     calls `estimateContractGas` BEFORE it ever calls `legacyTx` on the returned object, and the
 *     object it builds for the estimate is a fresh literal, not a spread of `params` (which is
 *     also never itself stamped with `type` before this point) - `type: "legacy"` cannot reach
 *     `estimateContractGas` in this code.
 * (3) `chains.ts`'s `roax.rpcUrls` resolved at module load, before the injected runtime config
 *     exists - CONFIRMED as a real, reproducible code hazard below (test group 3). `src/lib/
 *     env.public.ts` computes its exported `publicEnv` constant ONCE, at module-evaluation time,
 *     from whatever `window.__DOGTAG_VET_PUBLIC_CONFIG__` holds AT THAT INSTANT - a plain
 *     top-level `const`, not a live/reactive read. `chains.ts`'s `roax` chain object is built
 *     directly from that same one-shot `publicEnv.roaxRpcUrl` (not through the reactive
 *     `usePublicEnv()` hook `env.public.ts`'s own doc comment says exists for exactly this
 *     staleness hazard - but only on OTHER fields, never on `roax.rpcUrls`/`roax.id`, per that same
 *     doc comment's own reasoning: "every render that shows chain {roax.id} as text is itself
 *     gated behind client-only state ... so the branch that would show a stale value never paints
 *     first" - a UI-text-hydration argument, not a network-transport one). `wagmi.ts`'s
 *     `wagmiConfig` (built at ITS OWN module-evaluation time, importing `chains.ts`) then wires
 *     `roax` straight into `transports: {[roax.id]: http()}` - `http()` with no explicit URL falls
 *     back to `chain.rpcUrls.default.http[0]`, so the ENTIRE lifetime of that page's `usePublicClient()`
 *     read/estimate transport is pinned to whatever `roax.rpcUrls` happened to be the instant
 *     `chains.ts` first evaluated. If ANY client bundle path evaluates `chains.ts` (transitively,
 *     via `wagmi.ts`/`Providers.tsx`) before `PublicConfigInitScript`'s `beforeInteractive` script
 *     has actually run and set `window.__DOGTAG_VET_PUBLIC_CONFIG__`, the built-in fallback URL
 *     (`https://roax-testnet-rpc.dogtag.example/rpc` - a placeholder domain that resolves to
 *     nothing) is what `usePublicClient()` uses for `estimateContractGas` FOR THE REST OF THAT PAGE
 *     LOAD, even though the injected config later arrives correctly and every OTHER read of
 *     `publicEnv` (anything going through `usePublicEnv()`) would show it. A call against that
 *     placeholder throws (DNS/connect failure) - `legacyTxWithGas`'s catch fires - fail-open.
 *
 * Next.js's own `beforeInteractive` contract (script injected in `<head>`, before any other
 * framework/page script - verified in `src/app/layout.tsx`/`PublicConfigInitScript.tsx`) SHOULD
 * prevent this ordering in the standard SSR request path this repo actually renders - this file
 * does not claim to have reproduced the incident's exact browser-side race (that needs a real
 * browser hitting a real, possibly-caching-affected workstation load, which is out of reach here),
 * only that the codebase contains exactly the shape of hazard the incident brief asked to be
 * checked for, that it is real and reproducible in isolation, and that (per `usePublicEnv`'s own
 * doc comment) the developers' own stated assumption for this exact object - "the injection
 * script ... always executes first" - is the one thing that has to be false for it to fire. The
 * gas-floor fix in this same commit makes the CONSEQUENCE of this hazard harmless regardless of
 * whether it is ever confirmed as this incident's actual trigger: a stuck-fallback publicClient
 * still throws on estimate, `legacyTxWithGas` still falls back - now to the floor, never to the
 * wallet's own bare (unheadroomed) estimate.
 */
describe("2026-09-25 trigger investigation: (1) account field does not break estimateContractGas", () => {
  it("estimateContractGas is called with account present and a real client still succeeds (see chainWriteGas.integration.test.ts for the full RPC round trip)", async () => {
    const {legacyTxWithGas} = await import("@/lib/chainWrite");
    let sawAccount: unknown;
    const client = {
      estimateContractGas: async (arg: {account?: unknown}) => {
        sawAccount = arg.account;
        return 500_000n;
      },
    } as unknown as PublicClient;
    const result = await legacyTxWithGas(client, {
      address: "0x1111111111111111111111111111111111111111",
      abi: [{type: "function", name: "issueTag", inputs: [], outputs: [], stateMutability: "nonpayable"}] as const,
      functionName: "issueTag",
      account: "0x2222222222222222222222222222222222222222",
    });
    expect(sawAccount).toBe("0x2222222222222222222222222222222222222222");
    expect(result.gas).toBeGreaterThan(0n);
  });
});

describe("2026-09-25 trigger investigation: (2) type: legacy never leaks into the estimate call", () => {
  it("the object passed to estimateContractGas has no 'type' key at all", async () => {
    const {legacyTxWithGas} = await import("@/lib/chainWrite");
    let seenKeys: string[] = [];
    const client = {
      estimateContractGas: async (arg: object) => {
        seenKeys = Object.keys(arg);
        return 500_000n;
      },
    } as unknown as PublicClient;
    await legacyTxWithGas(client, {
      address: "0x1111111111111111111111111111111111111111",
      abi: [{type: "function", name: "issueTag", inputs: [], outputs: [], stateMutability: "nonpayable"}] as const,
      functionName: "issueTag",
      account: "0x2222222222222222222222222222222222222222",
    });
    expect(seenKeys).not.toContain("type");
    expect(seenKeys.sort()).toEqual(["account", "address", "args", "abi", "functionName"].sort());
  });
});

describe("2026-09-25 trigger investigation: (3) chains.ts's roax.rpcUrls is captured ONCE, at module-load time - a real staleness hazard if anything imports it before the injection script runs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("without window.__DOGTAG_VET_PUBLIC_CONFIG__ set yet (simulating a client module graph evaluated before PublicConfigInitScript's beforeInteractive script has run), roax.rpcUrls falls back to the build-time placeholder - and STAYS there even after the injected config 'arrives' afterward", async () => {
    // No `window` at all yet - mirrors this module's own Node.js SSR pass exactly (env.public.ts's
    // doc comment: "window is never defined in Node.js, so the injected branch is always empty
    // there"), but ALSO mirrors a browser race where this module is first evaluated before the
    // beforeInteractive script has executed: either way, `readInjectedConfig()` sees nothing.
    vi.resetModules();
    const {roax} = await import("@/lib/chains");

    const fallbackUrl = roax.rpcUrls.default.http[0];
    expect(fallbackUrl).toBe("https://roax-testnet-rpc.dogtag.example/rpc");

    // Now simulate PublicConfigInitScript actually running (the injected config "arrives") - in a
    // real page this happens on the SAME window, but env.public.ts's `publicEnv` was already
    // computed as a plain top-level `const` the instant `chains.ts` (transitively) imported it,
    // so nothing re-reads `window` afterward. Re-importing the SAME module specifiers (no
    // `vi.resetModules()` here - this is the point: within one page load, ES modules are
    // singletons) proves the chain object the app is already using never picks up the correction.
    vi.stubGlobal("window", {__DOGTAG_VET_PUBLIC_CONFIG__: {roaxRpcUrl: "https://devrpc.roax.net", roaxChainId: 135}});
    const {roax: roaxAfterInjection} = await import("@/lib/chains");
    expect(roaxAfterInjection.rpcUrls.default.http[0]).toBe(fallbackUrl); // UNCHANGED - same module instance
    expect(roaxAfterInjection).toBe(roax); // literally the same object - proves the singleton, not just equal values
  });

  it("control: importing chains.ts AFTER window.__DOGTAG_VET_PUBLIC_CONFIG__ is already set (the ordering PublicConfigInitScript's beforeInteractive placement is supposed to guarantee) picks up the real RPC URL correctly", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {__DOGTAG_VET_PUBLIC_CONFIG__: {roaxRpcUrl: "https://devrpc.roax.net", roaxChainId: 135}});
    const {roax} = await import("@/lib/chains");
    expect(roax.rpcUrls.default.http[0]).toBe("https://devrpc.roax.net");
    expect(roax.id).toBe(135);
  });

  it("a publicClient built against the stale fallback URL throws on estimateContractGas (unreachable placeholder domain) - the exact mechanism that would drive legacyTxWithGas's fail-open/floor branch", async () => {
    vi.resetModules();
    const {roax} = await import("@/lib/chains");
    const {createPublicClient, http} = await import("viem");
    const {legacyTxWithGas} = await import("@/lib/chainWrite");

    const staleClient = createPublicClient({chain: roax, transport: http(undefined, {retryCount: 0, timeout: 2_000})});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await legacyTxWithGas(staleClient, {
      address: "0x1111111111111111111111111111111111111111",
      abi: [{type: "function", name: "issueTag", inputs: [], outputs: [], stateMutability: "nonpayable"}] as const,
      functionName: "issueTag",
      account: "0x2222222222222222222222222222222222222222",
    });
    // The gas-floor fix (this same commit): even a publicClient permanently pointed at a dead
    // placeholder URL - the module-load-race outcome demonstrated above - still lands on a SAFE
    // floor, never on `undefined`/the wallet's own bare estimate.
    expect(result.gas).toBe(400_000n);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("estimateContractGas threw");
    warn.mockRestore();
  }, 10_000);
});
