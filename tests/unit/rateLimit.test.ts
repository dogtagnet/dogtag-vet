import {beforeEach, describe, expect, it} from "vitest";
import {checkRateLimit, clientKeyFromRequest, rateLimitHeaders, __resetRateLimitsForTests} from "@/lib/rateLimit";

beforeEach(() => {
  __resetRateLimitsForTests();
});

describe("checkRateLimit", () => {
  it("allows requests up to the limit within a window", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      const result = checkRateLimit({route: "test", clientKey: "1.2.3.4", limit: 3, windowMs: 60_000, now});
      expect(result.ok).toBe(true);
    }
  });

  it("rejects the request once the limit is exceeded within the same window", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      checkRateLimit({route: "test", clientKey: "1.2.3.4", limit: 3, windowMs: 60_000, now});
    }
    const fourth = checkRateLimit({route: "test", clientKey: "1.2.3.4", limit: 3, windowMs: 60_000, now});
    expect(fourth.ok).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets once the window elapses", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      checkRateLimit({route: "test", clientKey: "1.2.3.4", limit: 3, windowMs: 60_000, now});
    }
    const afterWindow = checkRateLimit({
      route: "test",
      clientKey: "1.2.3.4",
      limit: 3,
      windowMs: 60_000,
      now: now + 60_001,
    });
    expect(afterWindow.ok).toBe(true);
    expect(afterWindow.remaining).toBe(2);
  });

  it("tracks separate clients and separate routes independently", () => {
    const now = 1_000_000;
    checkRateLimit({route: "a", clientKey: "1.1.1.1", limit: 1, windowMs: 60_000, now});
    const otherClient = checkRateLimit({route: "a", clientKey: "2.2.2.2", limit: 1, windowMs: 60_000, now});
    const otherRoute = checkRateLimit({route: "b", clientKey: "1.1.1.1", limit: 1, windowMs: 60_000, now});
    expect(otherClient.ok).toBe(true);
    expect(otherRoute.ok).toBe(true);
  });

  it("decrements remaining on each successful call", () => {
    const now = 1_000_000;
    const first = checkRateLimit({route: "test", clientKey: "x", limit: 5, windowMs: 60_000, now});
    const second = checkRateLimit({route: "test", clientKey: "x", limit: 5, windowMs: 60_000, now});
    expect(first.remaining).toBe(4);
    expect(second.remaining).toBe(3);
  });
});

describe("rateLimitHeaders", () => {
  it("includes the three X-RateLimit-* headers on a successful result", () => {
    const headers = rateLimitHeaders({ok: true, limit: 10, remaining: 9, resetSeconds: 60});
    expect(headers["X-RateLimit-Limit"]).toBe("10");
    expect(headers["X-RateLimit-Remaining"]).toBe("9");
    expect(headers["X-RateLimit-Reset"]).toBe("60");
    expect(headers["Retry-After"]).toBeUndefined();
  });

  it("includes Retry-After only when the request was rejected", () => {
    const headers = rateLimitHeaders({ok: false, limit: 10, remaining: 0, resetSeconds: 30, retryAfterSeconds: 30});
    expect(headers["Retry-After"]).toBe("30");
  });
});

describe("clientKeyFromRequest", () => {
  it("uses the first hop of X-Forwarded-For", () => {
    const request = new Request("https://example.com", {headers: {"x-forwarded-for": "9.9.9.9, 10.0.0.1"}});
    expect(clientKeyFromRequest(request)).toBe("9.9.9.9");
  });

  it("falls back to a constant when no header is present", () => {
    const request = new Request("https://example.com");
    expect(clientKeyFromRequest(request)).toBe("unknown");
  });
});
