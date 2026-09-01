import {describe, expect, it} from "vitest";
import type {PublicClient} from "viem";
import {legacyTx, legacyTxWithGas} from "@/lib/chainWrite";

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

describe("legacyTxWithGas (headroom math + fail-open)", () => {
  const params = {address: ADDRESS, abi: ABI, functionName: "issueTag", account: ACCOUNT};

  it("adds 20% + 30000 headroom over the estimate", async () => {
    const client = fakePublicClient(100_000n);
    const result = await legacyTxWithGas(client, params);
    // 100_000 + 100_000/5 + 30_000 = 150_000
    expect(result.gas).toBe(150_000n);
    expect(result.type).toBe("legacy");
  });

  it("floors the 20% headroom (integer bigint division), never a fraction of a wei", async () => {
    const client = fakePublicClient(101n);
    const result = await legacyTxWithGas(client, params);
    // 101 + floor(101/5=20) + 30_000 = 30_121
    expect(result.gas).toBe(30_121n);
  });

  it("fails open to the plain legacyTx params (no gas field) when no publicClient is given", async () => {
    const result = await legacyTxWithGas(undefined, params);
    expect(result).toEqual({...params, type: "legacy"});
    expect(result.gas).toBeUndefined();
  });

  it("fails open to the plain legacyTx params when estimateContractGas throws", async () => {
    const client = fakePublicClient(new Error("RPC unreachable"));
    const result = await legacyTxWithGas(client, params);
    expect(result).toEqual({...params, type: "legacy"});
    expect(result.gas).toBeUndefined();
  });

  it("passes address/abi/functionName/args/account straight through to estimateContractGas", async () => {
    const seen: unknown[] = [];
    const client = {
      estimateContractGas: async (arg: unknown) => {
        seen.push(arg);
        return 42n;
      },
    } as unknown as PublicClient;
    await legacyTxWithGas(client, {...params, args: [1n, "0xroot"]});
    expect(seen).toEqual([{address: ADDRESS, abi: ABI, functionName: "issueTag", args: [1n, "0xroot"], account: ACCOUNT}]);
  });
});
