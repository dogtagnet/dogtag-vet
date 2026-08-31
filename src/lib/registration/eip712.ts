import {z} from "zod";
import type {Address, Hex} from "viem";
import {hexAddress, hex32, nonNegativeIntegerString} from "@/lib/schemas/common";

/**
 * The `ClientRegistration` EIP-712 struct - plans/wp4.2-client-wallet-registration.md, "The
 * signed message" (normative). This is THE production definition every real route signs/recovers
 * against; `tests/unit/eip712ClientRegistration.vectors.test.ts` deliberately keeps its OWN
 * separate hardcoded copy (see that file's doc comment for why), and
 * `tests/unit/registration/eip712.test.ts` feeds the shared fixture through THIS copy so a typo
 * here cannot pass unnoticed just because the other test's independent copy is correct.
 */
export const CLIENT_REGISTRATION_PRIMARY_TYPE = "ClientRegistration" as const;

export const CLIENT_REGISTRATION_TYPES = {
  ClientRegistration: [
    {name: "clinic", type: "address"},
    {name: "clientHash", type: "bytes32"},
    {name: "registrationId", type: "bytes32"},
    {name: "wallet", type: "address"},
    {name: "issuedAt", type: "uint64"},
    {name: "blockNumber", type: "uint64"},
    {name: "deadline", type: "uint64"},
  ],
} as const;

export interface ClientRegistrationDomain {
  name: "DogTagClientRegistration";
  version: "1";
  chainId: number;
  verifyingContract: Address;
}

export function buildClientRegistrationDomain(chainId: number, verifyingContract: Address): ClientRegistrationDomain {
  return {name: "DogTagClientRegistration", version: "1", chainId, verifyingContract};
}

/** The struct's field values in the shape viem's `recoverTypedDataAddress`/`hashTypedData`/
 * `signTypedData` want: the three uint64 fields as `bigint`, never `number` (see
 * `eip712ClientRegistration.vectors.test.ts`'s own doc comment on why `Number()` is unsafe at
 * 2^64-1). */
export interface ClientRegistrationMessage {
  clinic: Address;
  clientHash: Hex;
  registrationId: Hex; // right-padded bytes32 - see uuid.ts's registrationIdToHex32
  wallet: Address;
  issuedAt: bigint;
  blockNumber: bigint;
  deadline: bigint;
}

/** Same field values, wire-encoded for JSON persistence/transport: the three uint64 fields as
 * decimal strings, matching the shared vectors fixture's own per-vector `message` shape exactly -
 * this is also the shape a receipt's `payloadJson` embeds, so a receipt is byte-identical in kind
 * to a fixture vector's `{domain, message}` pair (minus the `expected` block). */
export interface ClientRegistrationMessageWire {
  clinic: Address;
  clientHash: Hex;
  registrationId: Hex;
  wallet: Address;
  issuedAt: string;
  blockNumber: string;
  deadline: string;
}

export function toWireMessage(message: ClientRegistrationMessage): ClientRegistrationMessageWire {
  return {
    clinic: message.clinic,
    clientHash: message.clientHash,
    registrationId: message.registrationId,
    wallet: message.wallet,
    issuedAt: message.issuedAt.toString(10),
    blockNumber: message.blockNumber.toString(10),
    deadline: message.deadline.toString(10),
  };
}

export function fromWireMessage(wire: ClientRegistrationMessageWire): ClientRegistrationMessage {
  return {
    clinic: wire.clinic,
    clientHash: wire.clientHash,
    registrationId: wire.registrationId,
    wallet: wire.wallet,
    issuedAt: BigInt(wire.issuedAt),
    blockNumber: BigInt(wire.blockNumber),
    deadline: BigInt(wire.deadline),
  };
}

/**
 * Deterministic, fixed-key-order JSON for `{domain, message}` exactly as EIP-712-signed - a
 * receipt's `payloadJson` (plans/wp4.2-client-wallet-registration.md: "the exact EIP-712 message
 * values + domain"), re-verifiable offline forever (scripts/verify-receipt.ts). Field order is
 * hardcoded below (never derived from object insertion order at a call site), so it can never
 * drift between two calls building the "same" payload.
 */
export function canonicalPayloadJson(domain: ClientRegistrationDomain, message: ClientRegistrationMessageWire): string {
  return JSON.stringify({
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    message: {
      clinic: message.clinic,
      clientHash: message.clientHash,
      registrationId: message.registrationId,
      wallet: message.wallet,
      issuedAt: message.issuedAt,
      blockNumber: message.blockNumber,
      deadline: message.deadline,
    },
  });
}

/** Validates a parsed `payloadJson` really is a well-formed `{domain, message}` pair before any
 * cryptographic operation touches it - `scripts/verify-receipt.ts` and `receipt.ts`'s
 * `verifyReceiptExport` both parse untrusted, possibly-hand-edited JSON through this rather than
 * trusting its shape. */
export const clientRegistrationPayloadSchema = z.object({
  domain: z.object({
    name: z.literal("DogTagClientRegistration"),
    version: z.literal("1"),
    chainId: z.number().int().nonnegative(),
    verifyingContract: hexAddress,
  }),
  message: z.object({
    clinic: hexAddress,
    clientHash: hex32,
    registrationId: hex32,
    wallet: hexAddress,
    issuedAt: nonNegativeIntegerString,
    blockNumber: nonNegativeIntegerString,
    deadline: nonNegativeIntegerString,
  }),
});

export type ClientRegistrationPayload = z.infer<typeof clientRegistrationPayloadSchema>;
