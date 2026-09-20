import {describe, expect, it} from "vitest";
import {DELEGATION_SESSION_TTL_SECS, createAddDelegationSession, createRevokeDelegationSession} from "@/lib/delegation/createSession";

describe("createAddDelegationSession", () => {
  it("fails closed when the chain is unreachable", async () => {
    const result = await createAddDelegationSession(1000, async () => {
      throw new Error("rpc down");
    });
    expect(result).toEqual({ok: false, code: "chain_unreachable"});
  });

  it("stamps a fixed 600s deadline and a 32-hex token", async () => {
    const result = await createAddDelegationSession(1000, async () => 555n);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deadline - result.issuedAt).toBe(DELEGATION_SESSION_TTL_SECS);
    expect(result.deadline - result.issuedAt).toBe(600);
    expect(result.token).toMatch(/^[0-9a-f]{32}$/);
    expect(result.blockNumber).toBe(555);
  });

  it("never reuses a token or registrationId across two calls", async () => {
    const a = await createAddDelegationSession(1000, async () => 1n);
    const b = await createAddDelegationSession(1000, async () => 1n);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.token).not.toBe(b.token);
      expect(a.registrationId).not.toBe(b.registrationId);
    }
  });
});

describe("createRevokeDelegationSession", () => {
  it("needs no chain read and stamps the same fixed 600s deadline", () => {
    const result = createRevokeDelegationSession(2000);
    expect(result.deadline - result.issuedAt).toBe(600);
    expect(result.token).toMatch(/^[0-9a-f]{32}$/);
  });
});
