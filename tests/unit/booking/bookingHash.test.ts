import {describe, expect, it} from "vitest";
import {concat, keccak256, toBytes} from "viem";
import {computeMobileBookingHash} from "@/lib/booking/bookingHash";

/**
 * `computeMobileBookingHash` is plans/wp4.4-mobile-booking-protocol.md section 2's `bookingHash`:
 * "keccak256 of the canonical booking content (serviceId | startAt | client.name/email/phone |
 * dogTagIdField-or-empty) - binding the signature to THIS booking so it cannot be replayed onto
 * another". The spec's prose is illustrative, not a literal delimited-string format: a plain
 * `join("|")` over free-text fields (name, phone) is ambiguous - `name="A|b@x.com", phone=""` and
 * `name="A", email="b@x.com"` (shifted) would hash identically if `|` were a literal separator
 * between otherwise-unescaped fields. This module instead hashes each of the six fields
 * INDEPENDENTLY first, then hashes the fixed-size (6*32-byte) concatenation of those six digests -
 * no delimiter, so no cross-field ambiguity is possible regardless of field content. This is the
 * NORMATIVE definition the iOS app must mirror byte-for-byte to produce a signature this server's
 * independent recomputation will accept; `tests/unit/vectors/mobile-booking-hash-vectors.json` (a
 * separate known-answer fixture, mirroring how the MobileBooking EIP-712 struct itself is
 * vectored) pins exact input/output pairs for cross-language parity testing.
 */
describe("computeMobileBookingHash", () => {
  const base = {
    serviceId: "svc-checkup",
    startAt: 1735689600,
    clientName: "Jordan Alvarez",
    clientEmail: "jordan@example.com",
    clientPhone: "+1-555-0100",
    dogTagIdField: "123456789",
  };

  it("independently recomputes to hash-of-hashes over the six fields in order, with no delimiter", () => {
    const expected = keccak256(
      concat([
        keccak256(toBytes(base.serviceId)),
        keccak256(toBytes(String(base.startAt))),
        keccak256(toBytes(base.clientName)),
        keccak256(toBytes(base.clientEmail)),
        keccak256(toBytes(base.clientPhone)),
        keccak256(toBytes(base.dogTagIdField)),
      ]),
    );
    expect(computeMobileBookingHash(base)).toBe(expected);
  });

  it("is deterministic - the same input always hashes the same", () => {
    expect(computeMobileBookingHash(base)).toBe(computeMobileBookingHash({...base}));
  });

  it("trims name/phone and trims+lowercases email before hashing, matching client-record normalization", () => {
    const padded = {...base, clientName: "  Jordan Alvarez  ", clientEmail: "  Jordan@Example.com  ", clientPhone: "  +1-555-0100  "};
    expect(computeMobileBookingHash(padded)).toBe(computeMobileBookingHash(base));
  });

  it("hashes an absent phone identically to an empty string", () => {
    const {clientPhone: _clientPhone, ...withoutPhone} = base;
    void _clientPhone;
    expect(computeMobileBookingHash(withoutPhone)).toBe(computeMobileBookingHash({...base, clientPhone: ""}));
  });

  it("hashes an absent dogTagIdField identically to an empty string (no tag claim in this booking)", () => {
    const {dogTagIdField: _dogTagIdField, ...withoutTag} = base;
    void _dogTagIdField;
    expect(computeMobileBookingHash(withoutTag)).toBe(computeMobileBookingHash({...base, dogTagIdField: ""}));
  });

  it("changes when serviceId changes", () => {
    expect(computeMobileBookingHash({...base, serviceId: "svc-other"})).not.toBe(computeMobileBookingHash(base));
  });

  it("changes when startAt changes (binds to the specific slot - no replay onto a different time)", () => {
    expect(computeMobileBookingHash({...base, startAt: base.startAt + 1})).not.toBe(computeMobileBookingHash(base));
  });

  it("changes when client name, email, or phone individually change", () => {
    const h = computeMobileBookingHash(base);
    expect(computeMobileBookingHash({...base, clientName: "Someone Else"})).not.toBe(h);
    expect(computeMobileBookingHash({...base, clientEmail: "someone@else.com"})).not.toBe(h);
    expect(computeMobileBookingHash({...base, clientPhone: "+1-555-9999"})).not.toBe(h);
  });

  it("changes when the tag claim changes", () => {
    expect(computeMobileBookingHash({...base, dogTagIdField: "987654321"})).not.toBe(computeMobileBookingHash(base));
  });

  it("does not collide when content shifts across a would-be delimiter boundary (the join(\"|\") failure mode)", () => {
    // If bookingHash were `[name, email, phone].join("|")`-style, these two would hash identically:
    // moving text from one field into the next while keeping the joined string's bytes the same.
    const a = computeMobileBookingHash({...base, clientName: "A|b@x.com", clientEmail: "x@x.com", clientPhone: ""});
    const b = computeMobileBookingHash({...base, clientName: "A", clientEmail: "b@x.com", clientPhone: "x@x.com"});
    expect(a).not.toBe(b);
  });

  it("produces a 32-byte 0x-prefixed hex hash", () => {
    expect(computeMobileBookingHash(base)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
