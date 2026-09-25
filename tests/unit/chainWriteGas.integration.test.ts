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

  it("the gas it sends carries +20% + 30_000 headroom over whatever the stub's eth_estimateGas answers, once that headroom clears the floor", async () => {
    await resetRpcStub();
    // issueTag's floor is 400_000n (src/lib/chainWrite.ts GAS_FLOORS) - a 900_000n estimate's own
    // headroom formula clears that on its own, isolating the headroom-formula path from the floor
    // path (covered by its own test below) even through a real RPC round trip.
    await setRpcGasEstimate(900_000n);

    const publicClient = createPublicClient({chain: roax, transport: http(RPC_STUB_URL)});
    const result = await legacyTxWithGas(publicClient, {
      address: "0x1111111111111111111111111111111111111111",
      abi: [
        {type: "function", name: "issueTag", stateMutability: "nonpayable", inputs: [], outputs: []},
      ] as const,
      functionName: "issueTag",
      account: "0x2222222222222222222222222222222222222222",
    });

    // 900_000 + 900_000/5 (180_000) + 30_000 = 1_110_000 - strictly more than the bare stubbed estimate.
    expect(result.gas).toBe(1_110_000n);
    expect(result.gas).toBeGreaterThan(900_000n);
    expect(result.type).toBe("legacy");
  });

  it("a different stubbed estimate changes the sent gas by exactly the same headroom formula", async () => {
    await resetRpcStub();
    await setRpcGasEstimate(1_000_000n);

    const publicClient = createPublicClient({chain: roax, transport: http(RPC_STUB_URL)});
    const result = await legacyTxWithGas(publicClient, {
      address: "0x1111111111111111111111111111111111111111",
      abi: [
        {type: "function", name: "revokeTag", stateMutability: "nonpayable", inputs: [], outputs: []},
      ] as const,
      functionName: "revokeTag",
      account: "0x2222222222222222222222222222222222222222",
    });

    expect(result.gas).toBe(1_230_000n); // 1_000_000 + 200_000 + 30_000
  });

  it("2026-09-25 incident shape over a REAL RPC round trip: a stubbed estimate whose headroom formula lands below the floor still sends the floor, never the bare/under-headroomed estimate", async () => {
    await resetRpcStub();
    // Mirrors the incident: a low (gas-price-0-style) estimate whose +20%+30k headroom still lands
    // well under issueTag's 400_000n floor.
    await setRpcGasEstimate(100_000n);

    const publicClient = createPublicClient({chain: roax, transport: http(RPC_STUB_URL)});
    const result = await legacyTxWithGas(publicClient, {
      address: "0x1111111111111111111111111111111111111111",
      abi: [
        {type: "function", name: "issueTag", stateMutability: "nonpayable", inputs: [], outputs: []},
      ] as const,
      functionName: "issueTag",
      account: "0x2222222222222222222222222222222222222222",
    });

    // 100_000 + 20_000 + 30_000 = 150_000, under the 400_000n floor - the floor must win even
    // though the estimate call itself succeeded over a real network round trip.
    expect(result.gas).toBe(400_000n);
  });
});
