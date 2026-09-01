import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {createPublicClient, http} from "viem";
import {roax} from "@/lib/chains";
import {legacyTxWithGas} from "@/lib/chainWrite";
import {RPC_STUB_URL, resetRpcStub, setRpcGasEstimate, startRpcStub, stopStartedRpcStub} from "../../e2e/rpcStub";

/**
 * WP4.5 track3-mint item 1's "assert the sent gas carries headroom over the stubbed estimate",
 * done as a vitest integration test against a REAL local RPC server (the same `e2e/rpcStub.ts` the
 * Playwright suite uses) rather than the full browser/wallet-connector path: `legacyTxWithGas`'s
 * gas math is exercised purely client-side (no wallet, no signing, no transaction ever sent) by a
 * real `viem` `PublicClient` making a real HTTP round trip to `eth_estimateGas` - this is a
 * genuine network round trip through the exact same code `TagIssueWizard`/`TagsTable`/
 * `VerifySessionPanel` call, just without the wagmi/browser/MetaMask machinery those components
 * also need (this app has no mock wallet connector today, and none is worth adding solely for this
 * one assertion - `tests/unit/chainWrite.test.ts`'s fake-`PublicClient` unit tests already cover
 * the headroom math and fail-open branch in complete isolation; this file's job is specifically to
 * prove the real RPC-call plumbing agrees).
 */
describe("legacyTxWithGas against a real RPC stub (network round trip, not a fake PublicClient)", () => {
  beforeAll(() => {
    startRpcStub();
  });

  afterAll(async () => {
    await stopStartedRpcStub();
  });

  it("the gas it sends carries +20% + 30_000 headroom over whatever the stub's eth_estimateGas answers", async () => {
    await resetRpcStub();
    await setRpcGasEstimate(300_000n);

    const publicClient = createPublicClient({chain: roax, transport: http(RPC_STUB_URL)});
    const result = await legacyTxWithGas(publicClient, {
      address: "0x1111111111111111111111111111111111111111",
      abi: [
        {type: "function", name: "issueTag", stateMutability: "nonpayable", inputs: [], outputs: []},
      ] as const,
      functionName: "issueTag",
      account: "0x2222222222222222222222222222222222222222",
    });

    // 300_000 + 300_000/5 (60_000) + 30_000 = 390_000 - strictly more than the bare stubbed estimate.
    expect(result.gas).toBe(390_000n);
    expect(result.gas!).toBeGreaterThan(300_000n);
    expect(result.type).toBe("legacy");
  });

  it("a different stubbed estimate changes the sent gas by exactly the same headroom formula", async () => {
    await resetRpcStub();
    await setRpcGasEstimate(100_000n);

    const publicClient = createPublicClient({chain: roax, transport: http(RPC_STUB_URL)});
    const result = await legacyTxWithGas(publicClient, {
      address: "0x1111111111111111111111111111111111111111",
      abi: [
        {type: "function", name: "revokeTag", stateMutability: "nonpayable", inputs: [], outputs: []},
      ] as const,
      functionName: "revokeTag",
      account: "0x2222222222222222222222222222222222222222",
    });

    expect(result.gas).toBe(150_000n); // 100_000 + 20_000 + 30_000
  });
});
