import {concat, keccak256, toBytes} from "viem";
import type {Hex} from "viem";

/**
 * `bookingHash` - plans/wp4.4-mobile-booking-protocol.md section 2: keccak256 of the canonical
 * booking content (serviceId | startAt | client.name/email/phone | dogTagIdField-or-empty),
 * binding a `MobileBooking` EIP-712 signature to THIS booking's content so it cannot be replayed
 * onto another (a different slot, a different service, a different claimed client, or a different
 * tag claim all produce a different hash, hence a different signed digest).
 *
 * The spec's "field | field | field" notation is illustrative, not a literal delimited string: two
 * of these fields (`clientName`, `clientPhone`) are free text a caller controls, and a plain
 * `[a, b, c].join("|")` is ambiguous whenever a field can itself contain the delimiter (or when
 * content can shift across a field boundary while keeping the joined bytes identical - see this
 * module's test for a concrete colliding pair under a naive join). Instead, each field is hashed
 * to a fixed-size 32-byte digest FIRST, and the six digests (not the raw field bytes) are
 * concatenated and hashed again - no delimiter ever appears between two variable-length inputs, so
 * no cross-field ambiguity is possible regardless of field content.
 *
 * NORMATIVE: this is the exact algorithm the DogTag app must reproduce, byte-for-byte, before
 * signing a `MobileBooking` message - a mismatch here means a genuinely-signed claim recovers to
 * the wrong digest and the server rejects the whole booking (Q2). See docs/mobile-booking.md and
 * `protocol/specs/mobile-booking-hash-vectors.json` (a known-answer fixture for cross-language
 * parity, mirroring how the MobileBooking EIP-712 struct itself is vectored).
 *
 * Normalization (applied here, not left to the caller, so there is exactly one place this can
 * drift): `serviceId` and `startAt` are used as-is (the wire's own validated values - `startAt` as
 * its base-10 unix-seconds string, computed the SAME way the route derives it for persistence,
 * `Math.floor(Date.parse(startAtIso) / 1000)`); `clientName`/`clientPhone` are trimmed;
 * `clientEmail` is trimmed AND lowercased (matching `clientMatch.ts`'s own client-record
 * normalization, since a client whose email differs only by case must still resolve to the same
 * hash); an absent `clientPhone` or `dogTagIdField` hashes identically to `""` (no tag claim /
 * no phone on file are both real, common shapes - not error cases).
 */
export interface BookingHashInput {
  serviceId: string;
  /** Unix seconds. */
  startAt: number;
  clientName: string;
  clientEmail: string;
  clientPhone?: string;
  /** The canonical on-chain field-form dogTagId, decimal string - `""`/absent when this booking
   * carries no tag claim at all. */
  dogTagIdField?: string;
}

function hashField(value: string): Hex {
  return keccak256(toBytes(value));
}

export function computeMobileBookingHash(input: BookingHashInput): Hex {
  const fieldDigests: Hex[] = [
    hashField(input.serviceId),
    hashField(String(input.startAt)),
    hashField(input.clientName.trim()),
    hashField(input.clientEmail.trim().toLowerCase()),
    hashField(input.clientPhone?.trim() ?? ""),
    hashField(input.dogTagIdField?.trim() ?? ""),
  ];
  return keccak256(concat(fieldDigests));
}
