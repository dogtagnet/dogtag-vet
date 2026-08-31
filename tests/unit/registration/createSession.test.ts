import {describe, expect, it} from "vitest";
import {computeClientHash} from "@/lib/registration/clientHash";
import {REGISTRATION_TOKEN_TTL_SECS, createRegistrationSession} from "@/lib/registration/createSession";

/**
 * plans/wp4.2-client-wallet-registration.md, dogtag-vet section 3: session creation stamps a
 * server-side `issuedAt` and a server-fetched ROAX `blockNumber`, and "session creation FAILS
 * CLOSED if the RPC is unreachable" (chain presence is part of the receipt, never guessed). This
 * mirrors `lib/mint/preflight.ts`'s fail-closed pattern: an injected chain-read function that
 * THROWS on failure, caught here and turned into a typed `chain_unreachable` result rather than
 * an escaping exception or a fabricated block number.
 */
describe("createRegistrationSession", () => {
  const clientFields = {name: "Jordan Alvarez", email: "jordan@example.com"};
  const now = 1_735_689_600;

  it("fails closed when the chain read throws, and produces no token or session data", async () => {
    const result = await createRegistrationSession({clientFields}, now, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(result).toEqual({ok: false, code: "chain_unreachable"});
  });

  it("fails closed when the chain read rejects asynchronously (not just a synchronous throw)", async () => {
    const result = await createRegistrationSession({clientFields}, now, () => Promise.reject(new Error("timeout")));
    expect(result.ok).toBe(false);
  });

  it("on a successful chain read, stamps issuedAt=now, blockNumber from the chain, and deadline=now+600", async () => {
    const result = await createRegistrationSession({clientFields}, now, async () => 4_242n);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.issuedAt).toBe(now);
    expect(result.blockNumber).toBe(4242);
    expect(result.deadline).toBe(now + 600);
    expect(REGISTRATION_TOKEN_TTL_SECS).toBe(600);
  });

  it("produces a 32-lowercase-hex token matching the shared token grammar (specs/qr-formats.md)", async () => {
    const result = await createRegistrationSession({clientFields}, now, async () => 1n);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces a registrationId shaped like a UUID", async () => {
    const result = await createRegistrationSession({clientFields}, now, async () => 1n);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.registrationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("computes clientHash exactly as computeClientHash(clientFields, registrationId) would - not some other derivation", async () => {
    const result = await createRegistrationSession({clientFields}, now, async () => 1n);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.clientHash).toBe(computeClientHash(clientFields, result.registrationId));
  });

  it("generates a fresh token and registrationId on every call - never reuses one across sessions", async () => {
    const first = await createRegistrationSession({clientFields}, now, async () => 1n);
    const second = await createRegistrationSession({clientFields}, now, async () => 1n);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(first.token).not.toBe(second.token);
    expect(first.registrationId).not.toBe(second.registrationId);
    expect(first.clientHash).not.toBe(second.clientHash); // different registrationId -> different hash
  });

  it("always attempts the chain read, and a slow-but-eventually-successful read still succeeds", async () => {
    let attempted = false;
    const result = await createRegistrationSession({clientFields}, now, async () => {
      attempted = true;
      return 999n;
    });
    expect(attempted).toBe(true);
    expect(result.ok).toBe(true);
  });
});
