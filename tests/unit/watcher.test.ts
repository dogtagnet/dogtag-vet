import {describe, expect, it} from "vitest";
import type {PublicClient} from "viem";
import {scanNativeTransfers, scanErc20Transfers} from "@/lib/payments/watcher";
import {matchTransfers, type OpenRail} from "@/lib/payments/match";

/**
 * WP4.18 V5 - the watcher's two ROAX detection paths (native PLASMA scan, RUSD Transfer-log scan)
 * against a fake RPC, proving detection of an exact transfer of each kind and rejection of a short
 * one. `scanNativeTransfers`/`scanErc20Transfers` are exported from watcher.ts purely for this
 * file - `scanChain` (the only production caller) is untested directly here since it also touches
 * Mongo (PaymentChainCursor, Payment); these two functions are the actual chain-observation logic
 * plan V5 names, and are exercised end to end (scan -> match) by feeding their real output through
 * the real matchTransfers (never re-implemented here), the same function the production watcher
 * itself calls - a passing test is proof the production code path detects/rejects, not a parallel
 * check it could diverge from.
 *
 * The fake client implements only the two methods each scan function actually calls
 * (getBlock/getContractEvents) - viem's PublicClient type is otherwise irrelevant to this test.
 */
const RECEIVING = "0x1111111111111111111111111111111111111a";
const RUSD_ADDRESS = "0x2222222222222222222222222222222222222b";
const SENDER = "0xc0ffee00000000000000000000000000000000";

function fakePlasmaClient(txs: {to: string; from: string; value: bigint; hash: string}[]): PublicClient {
  return {
    getBlock: async () => ({transactions: txs}),
  } as unknown as PublicClient;
}

function fakeRusdClient(logs: {from: string; to: string; value: bigint; blockNumber: bigint; transactionHash: string}[]): PublicClient {
  return {
    getContractEvents: async () =>
      logs.map((log) => ({
        address: RUSD_ADDRESS,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        args: {from: log.from, to: log.to, value: log.value},
      })),
  } as unknown as PublicClient;
}

function plasmaRail(overrides: Partial<OpenRail> = {}): OpenRail {
  return {
    paymentId: "pay-plasma",
    chainKey: "roax",
    token: "PLASMA",
    tokenAddress: undefined,
    receivingAddress: RECEIVING,
    amountBase: "25000000000000000", // 0.025 PLASMA, dust suffix included
    ...overrides,
  };
}

function rusdRail(overrides: Partial<OpenRail> = {}): OpenRail {
  return {
    paymentId: "pay-rusd",
    chainKey: "roax",
    token: "RUSD",
    tokenAddress: RUSD_ADDRESS,
    receivingAddress: RECEIVING,
    amountBase: "42500123", // 42.500123 RUSD, dust suffix included
    ...overrides,
  };
}

describe("watcher - ROAX native PLASMA scan", () => {
  it("detects an exact PLASMA transfer to the receiving address", async () => {
    const client = fakePlasmaClient([{to: RECEIVING, from: SENDER, value: 25_000_000_000_000_000n, hash: "0xplasmatx"}]);
    const transfers = await scanNativeTransfers(client, 100n, 100n, new Set([RECEIVING.toLowerCase()]));

    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({to: RECEIVING, tokenAddress: undefined, amountBase: "25000000000000000", txHash: "0xplasmatx"});

    const matches = matchTransfers(transfers, [plasmaRail()], /* currentBlock */ 100, /* requiredConfirmations */ 1);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.paymentId).toBe("pay-plasma");
  });

  it("rejects a SHORT PLASMA transfer - less than the exact amount owed never matches", async () => {
    const client = fakePlasmaClient([{to: RECEIVING, from: SENDER, value: 24_999_999_999_999_999n, hash: "0xplasmashort"}]);
    const transfers = await scanNativeTransfers(client, 100n, 100n, new Set([RECEIVING.toLowerCase()]));

    expect(transfers).toHaveLength(1); // the scan itself observes every transfer to the address...
    const matches = matchTransfers(transfers, [plasmaRail()], 100, 1);
    expect(matches).toHaveLength(0); // ...but matching is exact-amount only, so this one is rejected
  });

  it("ignores transactions to unrelated addresses even in the same block", async () => {
    const client = fakePlasmaClient([
      {to: "0x9999999999999999999999999999999999999a", from: SENDER, value: 25_000_000_000_000_000n, hash: "0xelsewhere"},
    ]);
    const transfers = await scanNativeTransfers(client, 100n, 100n, new Set([RECEIVING.toLowerCase()]));
    expect(transfers).toHaveLength(0);
  });
});

describe("watcher - ROAX RUSD Transfer-log scan", () => {
  it("detects an exact RUSD transfer to the receiving address", async () => {
    const client = fakeRusdClient([{from: SENDER, to: RECEIVING, value: 42_500_123n, blockNumber: 100n, transactionHash: "0xrusdtx"}]);
    const transfers = await scanErc20Transfers(client, 100n, 100n, [RUSD_ADDRESS], [RECEIVING]);

    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({to: RECEIVING, tokenAddress: RUSD_ADDRESS, amountBase: "42500123", txHash: "0xrusdtx"});

    const matches = matchTransfers(transfers, [rusdRail()], 100, 1);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.paymentId).toBe("pay-rusd");
  });

  it("rejects a SHORT RUSD transfer - less than the exact amount owed never matches", async () => {
    const client = fakeRusdClient([{from: SENDER, to: RECEIVING, value: 42_500_122n, blockNumber: 100n, transactionHash: "0xrusdshort"}]);
    const transfers = await scanErc20Transfers(client, 100n, 100n, [RUSD_ADDRESS], [RECEIVING]);

    expect(transfers).toHaveLength(1);
    const matches = matchTransfers(transfers, [rusdRail()], 100, 1);
    expect(matches).toHaveLength(0);
  });

  it("returns nothing when there are no open ERC-20 (RUSD) rails at all - never calls getContractEvents", async () => {
    let called = false;
    const client = {
      getContractEvents: async () => {
        called = true;
        return [];
      },
    } as unknown as PublicClient;
    const transfers = await scanErc20Transfers(client, 100n, 100n, [], []);
    expect(transfers).toEqual([]);
    expect(called).toBe(false); // tokenAddresses.length === 0 short-circuits before any RPC call
  });
});
