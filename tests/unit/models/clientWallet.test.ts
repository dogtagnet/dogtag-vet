import {describe, expect, it} from "vitest";
import {Client, type ClientWallet} from "@/lib/models/Client";

/**
 * Review finding 8: `registrationId`/`blockNumber` were widened to plain-optional for ALL
 * ClientWallet entries when WP4.4 introduced `via: "booking"` (whose MobileBooking struct carries
 * neither field) - dropping the invariant WalletsPanel's RegistrationSourcedWallet narrowing and
 * the receipt-export contract depend on. The schema now requires both CONDITIONALLY: mandatory
 * for a registration-sourced entry (`via` unset - the pre-field WP4.2 flow - or explicitly
 * `"registration"`), optional only for `via: "booking"`. `validateSync` runs mongoose validation
 * fully in memory, no database connection involved.
 */

function walletEntry(overrides: Partial<ClientWallet> = {}): Partial<ClientWallet> {
  return {
    address: "0x1234567890abcdef1234567890abcdef12345678",
    receipt: {payloadJson: "{}", signature: `0x${"11".repeat(65)}`, recoveredAt: 1},
    receiptHash: `0x${"22".repeat(32)}`,
    issuedAt: 1,
    registeredAt: 2,
    ...overrides,
  };
}

function validationErrorsFor(wallet: Partial<ClientWallet>): string[] {
  const doc = new Client({name: "Test Client", searchKey: "test client", wallets: [wallet]});
  const error = doc.validateSync();
  return Object.keys(error?.errors ?? {});
}

describe("ClientWallet registrationId/blockNumber conditional requirement (review finding 8)", () => {
  it("rejects a via-unset (legacy registration flow) entry missing registrationId and blockNumber", () => {
    const errors = validationErrorsFor(walletEntry());
    expect(errors).toContain("wallets.0.registrationId");
    expect(errors).toContain("wallets.0.blockNumber");
  });

  it('rejects an explicit via:"registration" entry missing them', () => {
    const errors = validationErrorsFor(walletEntry({via: "registration"}));
    expect(errors).toContain("wallets.0.registrationId");
    expect(errors).toContain("wallets.0.blockNumber");
  });

  it("accepts a registration-sourced entry that carries both", () => {
    expect(validationErrorsFor(walletEntry({via: "registration", registrationId: "reg-1", blockNumber: 123}))).toEqual([]);
    expect(validationErrorsFor(walletEntry({registrationId: "reg-1", blockNumber: 123}))).toEqual([]);
  });

  it('accepts a via:"booking" entry WITHOUT registrationId/blockNumber - the MobileBooking struct carries neither', () => {
    expect(validationErrorsFor(walletEntry({via: "booking", bookingId: "appt-1"}))).toEqual([]);
  });

  it("still enforces the unconditional fields on every entry regardless of via", () => {
    const errors = validationErrorsFor({via: "booking", bookingId: "appt-1"});
    expect(errors).toContain("wallets.0.address");
    expect(errors).toContain("wallets.0.receipt");
    expect(errors).toContain("wallets.0.receiptHash");
  });
});
