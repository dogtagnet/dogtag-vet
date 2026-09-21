import {afterEach, describe, expect, it, vi} from "vitest";
import {__resetOperatorStatusCacheForTests, resolveOperatorStatus} from "@/lib/issuanceOperatorStatus";

/**
 * WP4.7C item 3 - the helper matrix this item's own text asks for (whitelisted/not/no address/
 * unreadable), plus the two states its own design intent adds on top (`not-configured`, and the
 * cache's freshness/never-cache-a-failure behavior - see `issuanceOperatorStatus.ts`'s own doc
 * comments for why each of those exists). `deps.readOperator`/`deps.now` are injected so every
 * case here runs with zero network access.
 */

const CLONE = `0x${"1".repeat(40)}`;
const WALLET_A = `0x${"a".repeat(40)}`;
const WALLET_B = `0x${"b".repeat(40)}`;

afterEach(() => {
  __resetOperatorStatusCacheForTests();
});

describe("resolveOperatorStatus - the five-state matrix", () => {
  it("not-configured when no clone address is set up yet - never even attempts a read", async () => {
    const readOperator = vi.fn();
    const result = await resolveOperatorStatus({walletAddress: WALLET_A, cloneAddress: undefined}, {readOperator});
    expect(result.status).toBe("not-configured");
    expect(result.cloneConfigured).toBe(false);
    expect(readOperator).not.toHaveBeenCalled();
  });

  it("no-address when the clone is configured but this staff row has no recorded wallet", async () => {
    const readOperator = vi.fn();
    const result = await resolveOperatorStatus({walletAddress: undefined, cloneAddress: CLONE}, {readOperator});
    expect(result.status).toBe("no-address");
    expect(result.cloneConfigured).toBe(true);
    expect(readOperator).not.toHaveBeenCalled();
  });

  it("no-address for an empty-string wallet too (falsy, not just undefined/null)", async () => {
    const result = await resolveOperatorStatus({walletAddress: "", cloneAddress: CLONE});
    expect(result.status).toBe("no-address");
  });

  it("whitelisted when the chain read returns true", async () => {
    const readOperator = vi.fn().mockResolvedValue(true);
    const result = await resolveOperatorStatus({walletAddress: WALLET_A, cloneAddress: CLONE}, {readOperator});
    expect(result.status).toBe("whitelisted");
    expect(result.recordedAddress).toBe(WALLET_A);
    expect(readOperator).toHaveBeenCalledWith(CLONE, WALLET_A);
  });

  it("not-whitelisted when the chain read returns false - a real answer, not a guess", async () => {
    const readOperator = vi.fn().mockResolvedValue(false);
    const result = await resolveOperatorStatus({walletAddress: WALLET_A, cloneAddress: CLONE}, {readOperator});
    expect(result.status).toBe("not-whitelisted");
  });

  it("unreadable when the chain read throws - never silently treated as not-whitelisted", async () => {
    const readOperator = vi.fn().mockRejectedValue(new Error("RPC exploded"));
    const result = await resolveOperatorStatus({walletAddress: WALLET_A, cloneAddress: CLONE}, {readOperator});
    expect(result.status).toBe("unreadable");
    expect(result.recordedAddress).toBe(WALLET_A);
  });

  it("unreadable when the chain read hangs past the timeout - never lets a page render hang on it", async () => {
    const readOperator = vi.fn(() => new Promise<boolean>(() => {})); // never resolves
    const result = await resolveOperatorStatus(
      {walletAddress: WALLET_A, cloneAddress: CLONE},
      {readOperator, timeoutMs: 20},
    );
    expect(result.status).toBe("unreadable");
  });
});

describe("resolveOperatorStatus - the short cache", () => {
  it("a second call for the identical pair within the TTL hits the cache, not the chain", async () => {
    const readOperator = vi.fn().mockResolvedValue(true);
    let now = 1_000_000;
    const deps = {readOperator, now: () => now};

    const first = await resolveOperatorStatus({walletAddress: WALLET_A, cloneAddress: CLONE}, deps);
    expect(first.cached).toBe(false);
    expect(readOperator).toHaveBeenCalledTimes(1);

    now += 1_000; // well inside a 5s TTL
    const second = await resolveOperatorStatus({walletAddress: WALLET_A, cloneAddress: CLONE}, deps);
    expect(second.cached).toBe(true);
    expect(second.status).toBe("whitelisted");
    expect(readOperator).toHaveBeenCalledTimes(1);
  });

  it("expires after the TTL - a fresh read happens again, which is what lets item 4's grant-then-reload flow ever see the flip", async () => {
    const readOperator = vi.fn().mockResolvedValue(false);
    let now = 2_000_000;
    const deps = {readOperator, now: () => now};

    await resolveOperatorStatus({walletAddress: WALLET_A, cloneAddress: CLONE}, deps);
    expect(readOperator).toHaveBeenCalledTimes(1);

    now += 60_000; // well past a 5s TTL
    readOperator.mockResolvedValue(true); // simulate an owner having granted operator meanwhile
    const afterGrant = await resolveOperatorStatus({walletAddress: WALLET_A, cloneAddress: CLONE}, deps);
    expect(afterGrant.cached).toBe(false);
    expect(afterGrant.status).toBe("whitelisted");
    expect(readOperator).toHaveBeenCalledTimes(2);
  });

  it("never caches an unreadable result - the very next call retries the chain instead of repeating the failure", async () => {
    const readOperator = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce(true);
    const now = 3_000_000;
    const deps = {readOperator, now: () => now}; // same instant both times - proves this isn't just a TTL expiry

    const first = await resolveOperatorStatus({walletAddress: WALLET_A, cloneAddress: CLONE}, deps);
    expect(first.status).toBe("unreadable");

    const second = await resolveOperatorStatus({walletAddress: WALLET_A, cloneAddress: CLONE}, deps);
    expect(second.status).toBe("whitelisted");
    expect(readOperator).toHaveBeenCalledTimes(2);
  });

  it("keys the cache by (clone, wallet) - a different wallet on the same clone never reuses another's cached answer", async () => {
    const readOperator = vi.fn((_clone: string, wallet: string) => Promise.resolve(wallet === WALLET_A));
    const now = 4_000_000;
    const deps = {readOperator: readOperator as never, now: () => now};

    const a = await resolveOperatorStatus({walletAddress: WALLET_A, cloneAddress: CLONE}, deps);
    const b = await resolveOperatorStatus({walletAddress: WALLET_B, cloneAddress: CLONE}, deps);
    expect(a.status).toBe("whitelisted");
    expect(b.status).toBe("not-whitelisted");
    expect(readOperator).toHaveBeenCalledTimes(2);
  });

  it("is case-insensitive on both address halves of the cache key", async () => {
    const readOperator = vi.fn().mockResolvedValue(true);
    const now = 5_000_000;
    const deps = {readOperator, now: () => now};

    await resolveOperatorStatus({walletAddress: WALLET_A, cloneAddress: CLONE}, deps);
    const upper = await resolveOperatorStatus(
      {walletAddress: WALLET_A.toUpperCase().replace("0X", "0x"), cloneAddress: CLONE.toUpperCase().replace("0X", "0x")},
      deps,
    );
    expect(upper.cached).toBe(true);
    expect(readOperator).toHaveBeenCalledTimes(1);
  });

  it("__resetOperatorStatusCacheForTests actually clears it", async () => {
    const readOperator = vi.fn().mockResolvedValue(true);
    const deps = {readOperator, now: () => 6_000_000};
    await resolveOperatorStatus({walletAddress: WALLET_A, cloneAddress: CLONE}, deps);
    __resetOperatorStatusCacheForTests();
    await resolveOperatorStatus({walletAddress: WALLET_A, cloneAddress: CLONE}, deps);
    expect(readOperator).toHaveBeenCalledTimes(2);
  });
});
