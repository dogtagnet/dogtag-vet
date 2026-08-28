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
  it("falls back to a constant when no header is present", () => {
    const request = new Request("https://example.com");
    expect(clientKeyFromRequest(request)).toBe("unknown");
    expect(clientKeyFromRequest(request, 1)).toBe("unknown");
  });

  it("ignores X-Forwarded-For entirely when no trusted proxy hop is configured (the safe default)", () => {
    // The exact shape of the vulnerability this fix closes: a caller can put anything it wants in
    // this header. With TRUSTED_PROXY_HOPS at its default of 0, none of it is trusted.
    const request = new Request("https://example.com", {headers: {"x-forwarded-for": "9.9.9.9, 10.0.0.1"}});
    expect(clientKeyFromRequest(request)).toBe("unknown");
    expect(clientKeyFromRequest(request, 0)).toBe("unknown");
  });

  it("prefers CF-Connecting-IP over X-Forwarded-For", () => {
    const request = new Request("https://example.com", {
      headers: {"cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "9.9.9.9, 10.0.0.1"},
    });
    expect(clientKeyFromRequest(request, 1)).toBe("203.0.113.9");
  });

  it("with one trusted proxy hop, uses the rightmost X-Forwarded-For entry", () => {
    // Mirrors nginx's `proxy_add_x_forwarded_for`: whatever the client sent stays on the left,
    // and the proxy appends the real peer it saw on the right.
    const request = new Request("https://example.com", {headers: {"x-forwarded-for": "9.9.9.9, 203.0.113.50"}});
    expect(clientKeyFromRequest(request, 1)).toBe("203.0.113.50");
  });

  it("with two trusted proxy hops, uses the second-from-right entry", () => {
    const request = new Request("https://example.com", {
      headers: {"x-forwarded-for": "9.9.9.9, 203.0.113.50, 172.16.0.9"},
    });
    expect(clientKeyFromRequest(request, 2)).toBe("203.0.113.50");
  });

  it("falls back to unknown when fewer hops are present than configured", () => {
    const request = new Request("https://example.com", {headers: {"x-forwarded-for": "203.0.113.50"}});
    expect(clientKeyFromRequest(request, 2)).toBe("unknown");
  });

  it("a rotating leftmost (client-supplied) XFF entry no longer escapes the bucket, while the fixed trusted hop still gets limited", () => {
    // Reproduces the round-6 finding, then proves the fix: with a configured trusted hop, rotating
    // the client-controlled left entry never changes the derived key, so the SAME bucket keeps
    // counting every request and the limit still bites.
    const trustedHops = 1;
    const now = 1_000_000;
    const realPeer = "203.0.113.77"; // what the trusted reverse proxy actually observed
    let limited = 0;
    for (let i = 0; i < 5; i++) {
      const forgedLeftHop = `198.51.100.${i}`; // a different, attacker-chosen value every request
      const request = new Request("https://example.com", {
        headers: {"x-forwarded-for": `${forgedLeftHop}, ${realPeer}`},
      });
      const key = clientKeyFromRequest(request, trustedHops);
      expect(key).toBe(realPeer);
      const result = checkRateLimit({route: "public", clientKey: key, limit: 3, windowMs: 60_000, now});
      if (!result.ok) limited++;
    }
    expect(limited).toBe(2); // 3 allowed, then 2 rejected - keyed on the fixed trusted hop, not the rotating one

    // Confirm the OLD vulnerable behavior really is gone: taking the leftmost entry (hops=0, so no
    // XFF is trusted at all, but this also demonstrates a rotating leftmost never lands in the same
    // bucket twice under the pre-fix logic) would have let every one of the 5 requests through.
    __resetRateLimitsForTests();
    let allowedIfVulnerable = 0;
    for (let i = 0; i < 5; i++) {
      const forgedLeftHop = `198.51.100.${i}`;
      const legacyLeftmostKey = forgedLeftHop; // what the old, unfixed implementation would have used
      const result = checkRateLimit({route: "public", clientKey: legacyLeftmostKey, limit: 3, windowMs: 60_000, now});
      if (result.ok) allowedIfVulnerable++;
    }
    expect(allowedIfVulnerable).toBe(5);
  });
});
