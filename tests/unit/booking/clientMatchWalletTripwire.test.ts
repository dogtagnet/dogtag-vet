import {afterEach, describe, expect, it, vi} from "vitest";
import {Client, type ClientWallet} from "@/lib/models/Client";
import {appendBookingWalletToClient} from "@/lib/booking/clientMatch";

/**
 * WP4.5 track3-sig fix 2 - the SAME write-verification tripwire as
 * `tests/unit/registration/mongoStore.test.ts`'s `appendWalletToClient` suite, for the OTHER
 * wallet-append call site the plan names (`lib/booking/clientMatch.ts:123`,
 * `appendBookingWalletToClient` - WP4.4's booking auto-attach). Both sites share the identical
 * atomic "push unless already present" idiom, so both need the identical protection against a
 * stale-schema model reporting a matched-but-not-actually-pushed result as truthy.
 */

function mockFindOneAndUpdate(result: unknown) {
  return vi.spyOn(Client, "findOneAndUpdate").mockReturnValue({lean: () => Promise.resolve(result)} as never);
}

const ENTRY: ClientWallet = {
  address: "0xdef0000000000000000000000000000000000def",
  via: "booking",
  bookingId: "appt-1",
  receipt: {payloadJson: "{}", signature: "0x00", recoveredAt: 0},
  receiptHash: `0x${"00".repeat(32)}`,
  issuedAt: 0,
  registeredAt: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("appendBookingWalletToClient (write-verification tripwire)", () => {
  it("throws rather than silently returning true when the returned doc has no wallets array at all", async () => {
    mockFindOneAndUpdate({clientId: "client-1", name: "Marly"});
    await expect(appendBookingWalletToClient("client-1", ENTRY)).rejects.toThrow(/client-1/);
  });

  it("throws when the returned wallets array does not contain the pushed address", async () => {
    mockFindOneAndUpdate({clientId: "client-1", wallets: [{address: "0xsomeoneelse"}]});
    await expect(appendBookingWalletToClient("client-1", ENTRY)).rejects.toThrow(ENTRY.address);
  });

  it("resolves true when the returned doc genuinely contains the pushed address", async () => {
    mockFindOneAndUpdate({clientId: "client-1", wallets: [{address: ENTRY.address}]});
    await expect(appendBookingWalletToClient("client-1", ENTRY)).resolves.toBe(true);
  });

  it("resolves false (no error) when findOneAndUpdate finds no match at all - a legitimate lost race/already-attached case, not a tripwire concern", async () => {
    vi.spyOn(Client, "findOneAndUpdate").mockReturnValue({lean: () => Promise.resolve(null)} as never);
    await expect(appendBookingWalletToClient("client-1", ENTRY)).resolves.toBe(false);
  });
});
