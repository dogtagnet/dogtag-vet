import {describe, expect, it, beforeEach} from "vitest";
import {getSpotRate, __resetPriceCacheForTests, type FetchLike} from "@/lib/payments/priceFeed";

function fakeFetch(response: Record<string, Record<string, number>>): FetchLike {
  return async () => ({ok: true, json: async () => response});
}

function failingFetch(): FetchLike {
  return async () => {
    throw new Error("network down");
  };
}

describe("getSpotRate", () => {
  beforeEach(() => {
    __resetPriceCacheForTests();
  });

  it("returns a live rate on a successful fetch", async () => {
    const result = await getSpotRate(
      {fetchImpl: fakeFetch({ethereum: {usd: 2500.5}}), now: 0, apiBase: "https://example.test"},
      "ETH",
      "usd",
    );
    expect(result).toEqual({ok: true, rate: "2500.5", source: "live"});
  });

  it("serves from cache within the 10-minute window without calling fetch again", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return {ok: true, json: async () => ({"usd-coin": {usd: 1}})};
    };
    await getSpotRate({fetchImpl, now: 0, apiBase: "https://example.test"}, "USDC", "usd");
    const second = await getSpotRate({fetchImpl, now: 5 * 60 * 1000, apiBase: "https://example.test"}, "USDC", "usd");

    expect(calls).toBe(1);
    expect(second).toEqual({ok: true, rate: "1", source: "cached"});
  });

  it("re-fetches once the 10-minute cache window has elapsed", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return {ok: true, json: async () => ({tether: {usd: 1}})};
    };
    await getSpotRate({fetchImpl, now: 0, apiBase: "https://example.test"}, "USDT", "usd");
    await getSpotRate({fetchImpl, now: 11 * 60 * 1000, apiBase: "https://example.test"}, "USDT", "usd");

    expect(calls).toBe(2);
  });

  it("falls back to the last cached rate on a live fetch failure", async () => {
    await getSpotRate({fetchImpl: fakeFetch({ethereum: {usd: 3000}}), now: 0, apiBase: "https://example.test"}, "ETH", "usd");
    // Force past the cache TTL so the next call actually attempts (and fails) a live fetch.
    const result = await getSpotRate(
      {fetchImpl: failingFetch(), now: 20 * 60 * 1000, apiBase: "https://example.test"},
      "ETH",
      "usd",
    );
    expect(result).toEqual({ok: false, staleRate: "3000"});
  });

  it("reports failure with no stale rate when nothing was ever cached", async () => {
    const result = await getSpotRate({fetchImpl: failingFetch(), now: 0, apiBase: "https://example.test"}, "ETH", "eur");
    expect(result).toEqual({ok: false});
  });

  it("treats a malformed response body as a failure rather than throwing", async () => {
    const result = await getSpotRate(
      {fetchImpl: fakeFetch({}), now: 0, apiBase: "https://example.test"},
      "ETH",
      "usd",
    );
    expect(result.ok).toBe(false);
  });
});
