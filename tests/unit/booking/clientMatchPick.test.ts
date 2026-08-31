import {describe, expect, it} from "vitest";
import {pickDeterministicWalletClient} from "@/lib/booking/clientMatch";
import type {ClientDoc, ClientWallet} from "@/lib/models/Client";

const WALLET = "0xAbCd567890abcdef1234567890abcdef12345678";

function entry(overrides: Partial<ClientWallet>): ClientWallet {
  return {
    address: WALLET.toLowerCase(),
    receipt: {payloadJson: "{}", signature: `0x${"11".repeat(65)}`, recoveredAt: 0},
    receiptHash: `0x${"22".repeat(32)}`,
    issuedAt: 0,
    registeredAt: 0,
    ...overrides,
  };
}

function client(clientId: string, wallets: ClientWallet[]): ClientDoc {
  return {
    clientId,
    name: `Client ${clientId}`,
    petIds: [],
    wallets,
    searchKey: clientId,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("pickDeterministicWalletClient (review finding 6)", () => {
  it("returns null for no matches", () => {
    expect(pickDeterministicWalletClient([], WALLET)).toBeNull();
  });

  it("returns the single match with multiMatch false", () => {
    const only = client("c-1", [entry({registeredAt: 500})]);
    expect(pickDeterministicWalletClient([only], WALLET)).toEqual({client: only, multiMatch: false});
  });

  it("picks the earliest ACTIVE registration of this wallet regardless of array order, and reports multiMatch", () => {
    const early = client("c-early", [entry({registeredAt: 1_000})]);
    const late = client("c-late", [entry({registeredAt: 3_000})]);

    for (const order of [
      [late, early],
      [early, late],
    ]) {
      const pick = pickDeterministicWalletClient(order, WALLET);
      expect(pick?.client.clientId).toBe("c-early");
      expect(pick?.multiMatch).toBe(true);
    }
  });

  it("ignores revoked entries and entries for OTHER addresses when ordering", () => {
    // c-1's only claim to an early time is a REVOKED entry (its active one is late); c-2's active
    // entry is earlier than c-1's active one - c-2 must win.
    const c1 = client("c-1", [entry({registeredAt: 100, revokedAt: 200}), entry({registeredAt: 5_000})]);
    const c2 = client("c-2", [entry({registeredAt: 2_000}), entry({address: `0x${"99".repeat(20)}`, registeredAt: 1})]);
    expect(pickDeterministicWalletClient([c1, c2], WALLET)?.client.clientId).toBe("c-2");
  });

  it("breaks a registeredAt tie by clientId so the order is total", () => {
    const b = client("c-b", [entry({registeredAt: 1_000})]);
    const a = client("c-a", [entry({registeredAt: 1_000})]);
    expect(pickDeterministicWalletClient([b, a], WALLET)?.client.clientId).toBe("c-a");
    expect(pickDeterministicWalletClient([a, b], WALLET)?.client.clientId).toBe("c-a");
  });

  it("compares addresses case-insensitively (stored lowercase, queried in any case)", () => {
    const c = client("c-1", [entry({registeredAt: 42})]);
    const pick = pickDeterministicWalletClient([c], WALLET.toUpperCase().replace("0X", "0x"));
    expect(pick?.client.clientId).toBe("c-1");
  });

  it("sorts a client with NO active entry for this wallet last (defensive - the query should never produce one)", () => {
    const ghost = client("c-ghost", [entry({registeredAt: 1, revokedAt: 2})]);
    const real = client("c-real", [entry({registeredAt: 9_000})]);
    expect(pickDeterministicWalletClient([ghost, real], WALLET)?.client.clientId).toBe("c-real");
  });
});
