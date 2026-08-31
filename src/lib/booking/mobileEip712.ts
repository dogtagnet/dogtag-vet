import {z} from "zod";
import type {Address, Hex} from "viem";
import {hexAddress, hex32, nonNegativeIntegerString} from "@/lib/schemas/common";

/**
 * The `MobileBooking` EIP-712 struct - plans/wp4.4-mobile-booking-protocol.md, section 2 "The
 * wallet claim is SIGNED, never trusted bare" (normative). This mirrors
 * `lib/registration/eip712.ts`'s `ClientRegistration` struct exactly (same domain shape, same
 * "server rebuilds everything, trusts nothing off the wire except the claimed wallet and
 * signature" idiom) - see that file's own doc comment for the pattern this one deliberately
 * repeats rather than generalizes: two independent copies (registration's and this one) can never
 * silently drift into signing the wrong struct for each other.
 *
 * THE PRODUCTION DEFINITION every real route signs/recovers against.
 * `tests/unit/eip712MobileBooking.vectors.test.ts` deliberately keeps its OWN separate hardcoded
 * copy (that file's doc comment explains why); `tests/unit/booking/mobileEip712.test.ts` feeds the
 * shared fixture through THIS copy so a typo here cannot pass unnoticed just because the other
 * test's independent copy is correct.
 */
export const MOBILE_BOOKING_PRIMARY_TYPE = "MobileBooking" as const;

export const MOBILE_BOOKING_TYPES = {
  MobileBooking: [
    {name: "clinic", type: "address"},
    {name: "bookingHash", type: "bytes32"},
    {name: "wallet", type: "address"},
    {name: "issuedAt", type: "uint64"},
    {name: "deadline", type: "uint64"},
  ],
} as const;

export interface MobileBookingDomain {
  name: "DogTagMobileBooking";
  version: "1";
  chainId: number;
  verifyingContract: Address;
}

export function buildMobileBookingDomain(chainId: number, verifyingContract: Address): MobileBookingDomain {
  return {name: "DogTagMobileBooking", version: "1", chainId, verifyingContract};
}

/** The struct's field values in the shape viem's `recoverTypedDataAddress`/`hashTypedData`/
 * `signTypedData` want: the two uint64 fields as `bigint`, never `number` (2^64-1 is a real,
 * tested edge - see the vectors fixture). */
export interface MobileBookingMessage {
  clinic: Address;
  bookingHash: Hex;
  wallet: Address;
  issuedAt: bigint;
  deadline: bigint;
}

/** Same field values, wire-encoded for JSON persistence/transport (a `ClientWallet` receipt's
 * `payloadJson`, matching the fixture's own per-vector `message` shape): the two uint64 fields as
 * decimal strings. */
export interface MobileBookingMessageWire {
  clinic: Address;
  bookingHash: Hex;
  wallet: Address;
  issuedAt: string;
  deadline: string;
}

export function toWireMessage(message: MobileBookingMessage): MobileBookingMessageWire {
  return {
    clinic: message.clinic,
    bookingHash: message.bookingHash,
    wallet: message.wallet,
    issuedAt: message.issuedAt.toString(10),
    deadline: message.deadline.toString(10),
  };
}

export function fromWireMessage(wire: MobileBookingMessageWire): MobileBookingMessage {
  return {
    clinic: wire.clinic,
    bookingHash: wire.bookingHash,
    wallet: wire.wallet,
    issuedAt: BigInt(wire.issuedAt),
    deadline: BigInt(wire.deadline),
  };
}

/** Deterministic, fixed-key-order JSON for `{domain, message}` exactly as EIP-712-signed - stored
 * as a booking-sourced `ClientWallet.receipt.payloadJson` (Q1's `via: "booking"` auto-attach),
 * mirroring `lib/registration/eip712.ts`'s `canonicalPayloadJson` for the same reason: field order
 * is hardcoded below, never derived from object insertion order at a call site, so it can never
 * drift between two calls building the "same" payload. */
export function canonicalPayloadJson(domain: MobileBookingDomain, message: MobileBookingMessageWire): string {
  return JSON.stringify({
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    message: {
      clinic: message.clinic,
      bookingHash: message.bookingHash,
      wallet: message.wallet,
      issuedAt: message.issuedAt,
      deadline: message.deadline,
    },
  });
}

/** Validates a parsed `payloadJson` really is a well-formed MobileBooking `{domain, message}` pair
 * - mirrors `clientRegistrationPayloadSchema`. Used only for the Wallets panel's read-only receipt
 * display (`decodeMobileBookingPayload` below); never a security check on its own. */
export const mobileBookingPayloadSchema = z.object({
  domain: z.object({
    name: z.literal("DogTagMobileBooking"),
    version: z.literal("1"),
    chainId: z.number().int().nonnegative(),
    verifyingContract: hexAddress,
  }),
  message: z.object({
    clinic: hexAddress,
    bookingHash: hex32,
    wallet: hexAddress,
    issuedAt: nonNegativeIntegerString,
    deadline: nonNegativeIntegerString,
  }),
});
export type MobileBookingPayload = z.infer<typeof mobileBookingPayloadSchema>;

/** Tolerant of malformed input (returns `null` rather than throwing) - a read-only display helper
 * for the Wallets panel's booking-sourced receipt rows, mirroring `registration/receipt.ts`'s
 * `decodeReceiptPayload`. */
export function decodeMobileBookingPayload(payloadJson: string): MobileBookingPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  const result = mobileBookingPayloadSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
