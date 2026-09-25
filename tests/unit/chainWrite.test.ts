import {describe, expect, it, vi} from "vitest";
import type {PublicClient} from "viem";
import {DEFAULT_GAS_FLOOR, GAS_FLOORS, legacyTx, legacyTxWithGas} from "@/lib/chainWrite";

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as const;
const ABI = [
  {
    type: "function",
    name: "issueTag",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

function fakePublicClient(estimate: (() => Promise<bigint>) | bigint | Error): PublicClient {
  return {
    estimateContractGas: async () => {
      if (typeof estimate === "bigint") return estimate;
      if (estimate instanceof Error) throw estimate;
      return estimate();
    },
  } as unknown as PublicClient;
}

describe("legacyTx", () => {
  it("stamps type: legacy onto whatever params it is given", () => {
    expect(legacyTx({foo: "bar"})).toEqual({foo: "bar", type: "legacy"});
  });
});

describe("legacyTxWithGas (headroom math, never fails open - incident 2026-09-25)", () => {
  const params = {address: ADDRESS, abi: ABI, functionName: "issueTag", account: ACCOUNT};

  it("adds 20% + 30000 headroom over the estimate when that headroom is already above the floor", async () => {
    // issueTag's floor is 400_000n - an estimate whose headroom formula clears that on its own.
    const client = fakePublicClient(500_000n);
    const result = await legacyTxWithGas(client, params);
    // 500_000 + 500_000/5 + 30_000 = 630_000
    expect(result.gas).toBe(630_000n);
    expect(result.type).toBe("legacy");
  });

  it("floors the 20% headroom (integer bigint division), never a fraction of a wei", async () => {
    // 2_000_000 sits comfortably above issueTag's 400_000n floor either way, so this isolates the
    // integer-division behavior from the floor logic covered by its own tests below.
    const client = fakePublicClient(2_000_001n);
    const result = await legacyTxWithGas(client, params);
    // 2_000_001 + floor(2_000_001/5=400_000) + 30_000 = 2_430_001
    expect(result.gas).toBe(2_430_001n);
  });

  it("passes address/abi/functionName/args/account straight through to estimateContractGas", async () => {
    const seen: unknown[] = [];
    const client = {
      estimateContractGas: async (arg: unknown) => {
        seen.push(arg);
        return 500_000n;
      },
    } as unknown as PublicClient;
    await legacyTxWithGas(client, {...params, args: [1n, "0xroot"]});
    expect(seen).toEqual([{address: ADDRESS, abi: ABI, functionName: "issueTag", args: [1n, "0xroot"], account: ACCOUNT}]);
  });

  describe("gas floors (2026-09-25 incident: legacyTxWithGas must NEVER fail open to the wallet's own bare estimate)", () => {
    it("uses the floor, not the bare estimate, when the estimate's headroom formula lands below the floor", async () => {
      // A 100_000n estimate mirrors the incident's own mechanism: eth_estimateGas run at gas price
      // 0 skips the refund transfer's real cost and comes back too low. 100_000 + 20_000 + 30_000
      // = 150_000, well under issueTag's 400_000n floor - the floor must win.
      const client = fakePublicClient(100_000n);
      const result = await legacyTxWithGas(client, params);
      expect(result.gas).toBe(GAS_FLOORS.issueTag);
      expect(result.gas).toBe(400_000n);
    });

    it("uses the headroom formula, not the floor, when the estimate's headroom formula already clears the floor", async () => {
      const client = fakePublicClient(1_000_000n);
      const result = await legacyTxWithGas(client, params);
      // 1_000_000 + 200_000 + 30_000 = 1_230_000, above the 400_000n floor.
      expect(result.gas).toBe(1_230_000n);
    });

    it("uses the floor (never undefined/no gas field) when there is no publicClient - this is the exact 2026-09-25 incident shape", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await legacyTxWithGas(undefined, params);
      expect(result.gas).toBe(400_000n);
      expect(result.type).toBe("legacy");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("issueTag");
      expect(warn.mock.calls[0]?.[0]).toContain("no public client");
      warn.mockRestore();
    });

    it("uses the floor (never undefined/no gas field) when estimateContractGas throws", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const client = fakePublicClient(new Error("RPC unreachable"));
      const result = await legacyTxWithGas(client, params);
      expect(result.gas).toBe(400_000n);
      expect(result.type).toBe("legacy");
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain("issueTag");
      expect(warn.mock.calls[0]?.[0]).toContain("estimateContractGas threw");
      warn.mockRestore();
    });

    it("every named refund-tail write has its own floor matching GAS_FLOORS, applied when the estimate throws", async () => {
      const client = fakePublicClient(new Error("RPC unreachable"));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      for (const [functionName, floor] of Object.entries(GAS_FLOORS)) {
        const result = await legacyTxWithGas(client, {...params, functionName});
        expect(result.gas, functionName).toBe(floor);
      }
      vi.restoreAllMocks();
    });

    it("addSecondaryOwner/revokeSecondaryOwner floors sit above their own measured wp4.15B gas-report max (1.50M / 1.40M)", () => {
      expect(GAS_FLOORS.addSecondaryOwner).toBeGreaterThan(1_500_000n);
      expect(GAS_FLOORS.revokeSecondaryOwner).toBeGreaterThan(1_400_000n);
    });

    it("falls back to DEFAULT_GAS_FLOOR for a functionName this table does not name", async () => {
      const client = fakePublicClient(new Error("RPC unreachable"));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await legacyTxWithGas(client, {...params, functionName: "someFutureRoaxWrite"});
      expect(result.gas).toBe(DEFAULT_GAS_FLOOR);
      expect(DEFAULT_GAS_FLOOR).toBeGreaterThan(0n);
      vi.restoreAllMocks();
    });
  });
});
