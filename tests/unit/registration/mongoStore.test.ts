import {afterEach, describe, expect, it, vi} from "vitest";
import {Client} from "@/lib/models/Client";
import {mongoRegistrationStore} from "@/lib/registration/mongoStore";

/**
 * WP4.5 track3-sig fix 2 - the write-verification tripwire on `appendWalletToClient`
 * (plans/wp4.5-track3sig-plan.md): `findOneAndUpdate` matching and returning a document is NOT
 * proof the `$push` it asked for actually landed (the forensic incident - a stale-schema-cached
 * model silently strips an unrecognized path under mongoose's default strict mode). This suite
 * mocks the ONE database call `appendWalletToClient` makes (`Client.findOneAndUpdate`) so it can
 * feed the REAL production function a "matched but did not actually push" result deterministically,
 * without needing a real database - `tests/unit/registration/staleModelRepro.integration.test.ts`
 * is the companion proof that a real stale-schema model really does produce exactly this shape of
 * result against a real mongod.
 */

function mockFindOneAndUpdate(result: unknown) {
  return vi.spyOn(Client, "findOneAndUpdate").mockReturnValue({lean: () => Promise.resolve(result)} as never);
}

const ENTRY = {
  address: "0xabc0000000000000000000000000000000000abc",
  registrationId: "reg-1",
  receipt: {payloadJson: "{}", signature: "0x00", recoveredAt: 0},
  receiptHash: `0x${"00".repeat(32)}`,
  issuedAt: 0,
  blockNumber: 0,
  registeredAt: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("appendWalletToClient (write-verification tripwire)", () => {
  it("throws rather than reporting ok when findOneAndUpdate matches but the returned doc has NO wallets array at all (the exact stale-schema shape)", async () => {
    mockFindOneAndUpdate({clientId: "client-1", name: "Marly"}); // no `wallets` key whatsoever
    await expect(mongoRegistrationStore.appendWalletToClient("client-1", ENTRY)).rejects.toThrow(/client-1/);
  });

  it("throws when the returned doc HAS a wallets array but it does not contain the pushed address", async () => {
    mockFindOneAndUpdate({clientId: "client-1", wallets: [{address: "0xsomeoneelse"}]});
    await expect(mongoRegistrationStore.appendWalletToClient("client-1", ENTRY)).rejects.toThrow(ENTRY.address);
  });

  it("resolves ok when the returned doc genuinely contains the pushed address", async () => {
    mockFindOneAndUpdate({clientId: "client-1", wallets: [{address: ENTRY.address}]});
    await expect(mongoRegistrationStore.appendWalletToClient("client-1", ENTRY)).resolves.toBe("ok");
  });

  it("matches the address case-insensitively (addresses are stored lowercase, but the tripwire must not be fooled by a stray-cased entry)", async () => {
    mockFindOneAndUpdate({clientId: "client-1", wallets: [{address: ENTRY.address.toUpperCase()}]});
    await expect(mongoRegistrationStore.appendWalletToClient("client-1", ENTRY)).resolves.toBe("ok");
  });

  it("still reports already_registered when findOneAndUpdate finds no match and the client exists - never confused with the tripwire", async () => {
    vi.spyOn(Client, "findOneAndUpdate").mockReturnValue({lean: () => Promise.resolve(null)} as never);
    vi.spyOn(Client, "exists").mockResolvedValue({_id: "x"} as never);
    await expect(mongoRegistrationStore.appendWalletToClient("client-1", ENTRY)).resolves.toBe("already_registered");
  });

  it("still reports not_found when findOneAndUpdate finds no match and the client does not exist", async () => {
    vi.spyOn(Client, "findOneAndUpdate").mockReturnValue({lean: () => Promise.resolve(null)} as never);
    vi.spyOn(Client, "exists").mockResolvedValue(null);
    await expect(mongoRegistrationStore.appendWalletToClient("client-1", ENTRY)).resolves.toBe("not_found");
  });
});
