import {describe, expect, it} from "vitest";
import {concat, keccak256, toBytes} from "viem";
import type {Hex} from "viem";
import vectors from "./vectors/mobile-booking-hash-vectors.json";

/**
 * Pins `tests/unit/vectors/mobile-booking-hash-vectors.json` against drift.
 *
 * That file is a known-answer vector set for `computeMobileBookingHash`
 * (`src/lib/booking/bookingHash.ts` - plans/wp4.4-mobile-booking-protocol.md section 2's
 * `bookingHash`), generated once by a standalone script against this repo's own installed viem
 * and intended to be copied byte-for-byte into dogtag-ios too, mirroring exactly how the
 * MobileBooking EIP-712 struct vectors (`eip712-mobile-booking-vectors.json`) and the WP4.2
 * ClientRegistration vectors were made.
 *
 * The recomputation below is INDEPENDENTLY hand-rolled from viem's primitives (`keccak256`,
 * `toBytes`, `concat`) rather than imported from `bookingHash.ts` - see
 * `tests/unit/eip712MobileBooking.vectors.test.ts`'s doc comment for why a fixture-pinning suite
 * keeps its own separate copy: this is the one check in the suite that is independent of the
 * production module, so a bug introduced there cannot silently "fix" both sides of the comparison
 * at once. `tests/unit/booking/bookingHash.test.ts` separately recomputes one vector's worth of
 * this same formula against the PRODUCTION module directly (mirroring
 * `tests/unit/registration/eip712.test.ts`'s "feed the fixture through the real module" role).
 */
interface BookingHashVector {
  name: string;
  description: string;
  input: {
    serviceId: string;
    startAt: number;
    clientName: string;
    clientEmail: string;
    clientPhone?: string;
    dogTagIdField?: string;
  };
  expected: {bookingHash: Hex};
}

const typedVectors = vectors as unknown as BookingHashVector[];

function independentRecompute(input: BookingHashVector["input"]): Hex {
  const hashField = (value: string): Hex => keccak256(toBytes(value));
  return keccak256(
    concat([
      hashField(input.serviceId),
      hashField(String(input.startAt)),
      hashField(input.clientName.trim()),
      hashField(input.clientEmail.trim().toLowerCase()),
      hashField(input.clientPhone?.trim() ?? ""),
      hashField(input.dogTagIdField?.trim() ?? ""),
    ]),
  );
}

describe("tests/unit/vectors/mobile-booking-hash-vectors.json", () => {
  it("has at least 6 vectors", () => {
    expect(typedVectors.length).toBeGreaterThanOrEqual(6);
  });

  it.each(typedVectors.map((v) => [v.name, v] as const))(
    "%s: independently recomputed hash-of-hashes matches the fixture's expected bookingHash",
    (_name, vector) => {
      expect(independentRecompute(vector.input)).toBe(vector.expected.bookingHash);
    },
  );

  it("gives every DISTINCT input a unique hash (the whitespace/case-normalized vector is deliberately a same-hash pair, not a bug)", () => {
    const hashes = typedVectors.map((v) => v.expected.bookingHash.toLowerCase());
    const uniqueHashes = new Set(hashes);
    // Exactly one intentional collision: "email-case-and-whitespace-normalized" hashes the same as
    // "baseline" by design (normalization proof) - every other vector's hash is unique.
    expect(uniqueHashes.size).toBe(typedVectors.length - 1);
    const baseline = typedVectors.find((v) => v.name === "baseline");
    const normalized = typedVectors.find((v) => v.name === "email-case-and-whitespace-normalized");
    expect(baseline).toBeDefined();
    expect(normalized).toBeDefined();
    expect(normalized!.expected.bookingHash.toLowerCase()).toBe(baseline!.expected.bookingHash.toLowerCase());
  });

  it("covers an absent clientPhone and an absent dogTagIdField", () => {
    expect(typedVectors.some((v) => v.input.clientPhone === undefined)).toBe(true);
    expect(typedVectors.some((v) => v.input.dogTagIdField === undefined)).toBe(true);
  });

  it("covers a client name containing a literal '|' (the join(\"|\") failure mode)", () => {
    expect(typedVectors.some((v) => v.input.clientName.includes("|"))).toBe(true);
  });

  it("covers non-ASCII input", () => {
    expect(typedVectors.some((v) => /[^\x00-\x7F]/.test(v.input.clientName))).toBe(true);
  });

  it("every vector's expected value is a well-formed 32-byte 0x-hex hash", () => {
    for (const vector of typedVectors) {
      expect(vector.expected.bookingHash).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});
