import {describe, expect, it} from "vitest";
import {matchTransfers, type ObservedTransfer, type OpenRail} from "@/lib/payments/match";

const RECEIVING = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function rail(overrides: Partial<OpenRail> = {}): OpenRail {
  return {
    paymentId: "pay-1",
    chainKey: "roax",
    token: "RUSD",
    tokenAddress: TOKEN,
    receivingAddress: RECEIVING,
    amountBase: "50000123",
    ...overrides,
  };
}

function transfer(overrides: Partial<ObservedTransfer> = {}): ObservedTransfer {
  return {
    to: RECEIVING,
    tokenAddress: TOKEN,
    amountBase: "50000123",
    blockNumber: 100,
    txHash: "0xdeadbeef",
    from: "0xC0FFEE0000000000000000000000000000000C",
    ...overrides,
  };
}

describe("matchTransfers", () => {
  it("matches an exact (to, token, amountBase-with-dust) transfer that has reached confirmation depth", () => {
    const matches = matchTransfers([transfer()], [rail()], /* currentBlock */ 102, /* requiredConfirmations */ 3);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.paymentId).toBe("pay-1");
    expect(matches[0]?.confirmations).toBe(3); // 102 - 100 + 1
  });

  it("ignores a transfer with the wrong amount to the right address", () => {
    const matches = matchTransfers([transfer({amountBase: "50000124"})], [rail()], 200, 1);
    expect(matches).toHaveLength(0);
  });

  it("ignores a transfer with the exact amount to an unrelated address", () => {
    const matches = matchTransfers(
      [transfer({to: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"})],
      [rail()],
      200,
      1,
    );
    expect(matches).toHaveLength(0);
  });

  it("ignores an exact-amount transfer on the wrong token contract", () => {
    const matches = matchTransfers(
      [transfer({tokenAddress: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"})],
      [rail()],
      200,
      1,
    );
    expect(matches).toHaveLength(0);
  });

  it("does not match a native transfer against an ERC-20 rail or vice versa", () => {
    const nativeTransfer = transfer({tokenAddress: undefined});
    const matches = matchTransfers([nativeTransfer], [rail()], 200, 1);
    expect(matches).toHaveLength(0);
  });

  it("does not match a transfer that has not yet reached the required confirmation depth", () => {
    // Block 100, current tip 100 -> 1 confirmation, but 3 required.
    const matches = matchTransfers([transfer({blockNumber: 100})], [rail()], 100, 3);
    expect(matches).toHaveLength(0);
  });

  it("matches the instant a transfer reaches exactly the required confirmation depth, not before", () => {
    const short = matchTransfers([transfer({blockNumber: 100})], [rail()], 101, 3); // 2 confirmations
    expect(short).toHaveLength(0);
    const exact = matchTransfers([transfer({blockNumber: 100})], [rail()], 102, 3); // 3 confirmations
    expect(exact).toHaveLength(1);
  });

  it("addresses compare case-insensitively", () => {
    const matches = matchTransfers(
      [transfer({to: RECEIVING.toLowerCase(), tokenAddress: TOKEN.toLowerCase()})],
      [rail()],
      200,
      1,
    );
    expect(matches).toHaveLength(1);
  });

  it("matches each transfer against the correct rail among several open payments on the same chain", () => {
    const railA = rail({paymentId: "pay-a", amountBase: "1000001"});
    const railB = rail({paymentId: "pay-b", amountBase: "1000002"});
    const matches = matchTransfers(
      [transfer({amountBase: "1000002"})],
      [railA, railB],
      200,
      1,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.paymentId).toBe("pay-b");
  });
});
