import {beforeEach, describe, expect, it, vi} from "vitest";
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  encodeErrorResult,
  HttpRequestError,
  type Address,
} from "viem";
import {entityRegistryAbi} from "@/lib/abi";

/**
 * WP4.21 V1 - the three new chain reads, driven through a fake chain: `createPublicClient` is
 * replaced by a client whose `readContract` answers from a per-test table of
 * `functionName -> value | thrown error`, using REAL viem error classes so the revert/transport
 * distinction the production code makes is exercised for real.
 */
type Answer = {value: unknown} | {error: unknown};
const chain: {answers: Record<string, Answer>; calls: string[]} = {answers: {}, calls: []};

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: async ({functionName}: {functionName: string}) => {
        chain.calls.push(functionName);
        const a = chain.answers[functionName];
        if (!a) throw new Error(`fake chain: no answer for ${functionName}`);
        if ("error" in a) throw a.error;
        return a.value;
      },
    }),
  };
});

import {readCloneOwner, readEntityKinds, readEntityKindsIfConfigured, readRegistryVersion} from "@/lib/chainRead";

const REGISTRY = "0x00000000000000000000000000000000000e9157" as Address;
const ACCOUNT = "0x0000000000000000000000000000000000000acc" as Address;
const CLONE = "0x0000000000000000000000000000000000c10be5" as Address;

function revertWith(errorName: string, functionName: string, args: unknown[] = []): BaseError {
  const data = encodeErrorResult({abi: entityRegistryAbi, errorName, args} as never);
  const inner = new ContractFunctionRevertedError({abi: entityRegistryAbi, data, functionName});
  return new BaseError("execution reverted", {cause: inner});
}
const emptyRevert = (fn: string) => new BaseError("reverted", {cause: new ContractFunctionZeroDataError({functionName: fn})});
const transportFailure = () => new BaseError("rpc down", {cause: new HttpRequestError({url: "http://rpc.invalid", body: {}, details: "timeout"})});

beforeEach(() => {
  chain.answers = {};
  chain.calls = [];
});

describe("readRegistryVersion", () => {
  it("returns the on-chain version when version() answers", async () => {
    chain.answers.version = {value: 2n};
    expect(await readRegistryVersion(REGISTRY)).toBe(2);
  });
  it("returns 1 when version() reverts with empty data (a registry that predates the function)", async () => {
    chain.answers.version = {error: emptyRevert("version")};
    expect(await readRegistryVersion(REGISTRY)).toBe(1);
  });
  it("returns 1 when version() reverts with a decoded error", async () => {
    chain.answers.version = {error: revertWith("UnknownEntity", "version", [ACCOUNT])};
    expect(await readRegistryVersion(REGISTRY)).toBe(1);
  });
  it("propagates a transport failure instead of mapping it to version 1", async () => {
    chain.answers.version = {error: transportFailure()};
    await expect(readRegistryVersion(REGISTRY)).rejects.toThrow();
  });
});

describe("readEntityKinds", () => {
  it("version 2: the mask from kindsOf", async () => {
    chain.answers.version = {value: 2n};
    chain.answers.kindsOf = {value: 10n};
    expect(await readEntityKinds(REGISTRY, ACCOUNT)).toEqual({status: "registered", mask: 10n});
    expect(chain.calls).not.toContain("getEntity");
  });
  it("version 2: an UnknownEntity revert is not_registered", async () => {
    chain.answers.version = {value: 2n};
    chain.answers.kindsOf = {error: revertWith("UnknownEntity", "kindsOf", [ACCOUNT])};
    expect(await readEntityKinds(REGISTRY, ACCOUNT)).toEqual({status: "not_registered"});
  });
  it("version 2: a transport failure on kindsOf is unreadable, never not_registered", async () => {
    chain.answers.version = {value: 2n};
    chain.answers.kindsOf = {error: transportFailure()};
    expect(await readEntityKinds(REGISTRY, ACCOUNT)).toEqual({status: "unreadable"});
  });
  it("version 2: some other revert on kindsOf is unreadable", async () => {
    chain.answers.version = {value: 2n};
    chain.answers.kindsOf = {error: emptyRevert("kindsOf")};
    expect(await readEntityKinds(REGISTRY, ACCOUNT)).toEqual({status: "unreadable"});
  });
  it("version 1 (version() reverts): the legacy kind becomes a one-bit mask", async () => {
    chain.answers.version = {error: emptyRevert("version")};
    chain.answers.getEntity = {value: {kind: 2, status: 1}};
    expect(await readEntityKinds(REGISTRY, ACCOUNT)).toEqual({status: "registered", mask: 4n});
    expect(chain.calls).not.toContain("kindsOf");
  });
  it("version 1: Vet (kind 1) is mask 2", async () => {
    chain.answers.version = {error: emptyRevert("version")};
    chain.answers.getEntity = {value: {kind: 1n}};
    expect(await readEntityKinds(REGISTRY, ACCOUNT)).toEqual({status: "registered", mask: 2n});
  });
  it("version 1: an UnknownEntity revert on getEntity is not_registered", async () => {
    chain.answers.version = {error: emptyRevert("version")};
    chain.answers.getEntity = {error: revertWith("UnknownEntity", "getEntity", [ACCOUNT])};
    expect(await readEntityKinds(REGISTRY, ACCOUNT)).toEqual({status: "not_registered"});
  });
  it("an unreadable chain at the version probe is unreadable", async () => {
    chain.answers.version = {error: transportFailure()};
    expect(await readEntityKinds(REGISTRY, ACCOUNT)).toEqual({status: "unreadable"});
  });
  it("a non-viem error is unreadable", async () => {
    chain.answers.version = {value: 2n};
    chain.answers.kindsOf = {error: new Error("boom")};
    expect(await readEntityKinds(REGISTRY, ACCOUNT)).toEqual({status: "unreadable"});
  });
});

describe("readCloneOwner", () => {
  it("returns vetOwner()", async () => {
    chain.answers.vetOwner = {value: ACCOUNT};
    expect(await readCloneOwner(CLONE)).toBe(ACCOUNT);
  });
  it("fails closed: an unreadable chain throws", async () => {
    chain.answers.vetOwner = {error: transportFailure()};
    await expect(readCloneOwner(CLONE)).rejects.toThrow();
  });
});

describe("readEntityKindsIfConfigured", () => {
  it("no registry address (or a malformed one) is unreadable and reads nothing", async () => {
    expect(await readEntityKindsIfConfigured(undefined, ACCOUNT)).toEqual({status: "unreadable"});
    expect(await readEntityKindsIfConfigured("", ACCOUNT)).toEqual({status: "unreadable"});
    expect(await readEntityKindsIfConfigured("not-an-address", ACCOUNT)).toEqual({status: "unreadable"});
    expect(chain.calls).toEqual([]);
  });
  it("a configured registry is read", async () => {
    chain.answers.version = {value: 2n};
    chain.answers.kindsOf = {value: 2n};
    expect(await readEntityKindsIfConfigured(REGISTRY, ACCOUNT)).toEqual({status: "registered", mask: 2n});
  });
});
