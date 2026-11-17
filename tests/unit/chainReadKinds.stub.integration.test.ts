import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {resetRpcStub, setRpcScenario, startRpcStub, stopStartedRpcStub} from "../../e2e/rpcStub";

/**
 * WP4.21 V1 - the same three reads, but over a REAL viem HTTP client against the e2e RPC stub, so the
 * revert-versus-transport classification is proven against genuine JSON-RPC revert replies (code 3
 * plus revert data), not only against hand-built error objects (chainReadKinds.test.ts).
 */
const REGISTRY = "0x00000000000000000000000000000000000e9157";
const ACCOUNT = "0x0000000000000000000000000000000000000acc";
const CLONE = "0x0000000000000000000000000000000000c10be5";
const OWNER = "0x00000000000000000000000000000000000000a1";

let chainRead: typeof import("@/lib/chainRead");

beforeAll(async () => {
  const {RPC_STUB_URL} = await import("../../e2e/rpcStub");
  process.env.ROAX_RPC_URL = RPC_STUB_URL;
  startRpcStub();
  chainRead = await import("@/lib/chainRead");
});
afterAll(async () => {
  await stopStartedRpcStub();
});
beforeEach(async () => {
  await resetRpcStub();
});

describe("kinds reads over a real viem client against the RPC stub", () => {
  it("an unscripted registry (no version selector): version 1, and an unknown account is not_registered", async () => {
    expect(await chainRead.readRegistryVersion(REGISTRY)).toBe(1);
    expect(await chainRead.readEntityKinds(REGISTRY, ACCOUNT)).toEqual({status: "not_registered"});
  });

  it("version 1 registry: the legacy kind (Government = 2) becomes mask 4", async () => {
    await setRpcScenario("getEntity", REGISTRY, [ACCOUNT], "2");
    expect(await chainRead.readEntityKinds(REGISTRY, ACCOUNT)).toEqual({status: "registered", mask: 4n});
  });

  it("version 2 registry: kindsOf mask, and an unknown account is not_registered", async () => {
    await setRpcScenario("version", REGISTRY, [], "uint:2");
    await setRpcScenario("kindsOf", REGISTRY, [ACCOUNT], "10");
    expect(await chainRead.readRegistryVersion(REGISTRY)).toBe(2);
    expect(await chainRead.readEntityKinds(REGISTRY, ACCOUNT)).toEqual({status: "registered", mask: 10n});
    expect(await chainRead.readEntityKinds(REGISTRY, "0x0000000000000000000000000000000000000bee")).toEqual({status: "not_registered"});
  });

  it("an RPC that fails every call is unreadable (never version 1, never not_registered); readCloneOwner throws", async () => {
    const {forceRpcCallFailure} = await import("../../e2e/rpcStub");
    await forceRpcCallFailure();
    await expect(chainRead.readRegistryVersion(REGISTRY)).rejects.toThrow();
    expect(await chainRead.readEntityKinds(REGISTRY, ACCOUNT)).toEqual({status: "unreadable"});
    await expect(chainRead.readCloneOwner(CLONE)).rejects.toThrow();
  });

  it("readCloneOwner reads vetOwner()", async () => {
    await setRpcScenario("vetOwner", CLONE, [], OWNER);
    expect((await chainRead.readCloneOwner(CLONE)).toLowerCase()).toBe(OWNER);
  });
});
