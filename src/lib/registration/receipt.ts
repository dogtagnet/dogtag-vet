import {z} from "zod";
import {keccak256, recoverTypedDataAddress, toBytes} from "viem";
import type {Address, Hex} from "viem";
import {hexAddress, hex32, hexSignature65} from "@/lib/schemas/common";
import {
  CLIENT_REGISTRATION_PRIMARY_TYPE,
  CLIENT_REGISTRATION_TYPES,
  clientRegistrationPayloadSchema,
  fromWireMessage,
  type ClientRegistrationDomain,
  type ClientRegistrationMessageWire,
  type ClientRegistrationPayload,
} from "@/lib/registration/eip712";

/**
 * The full receipt persisted per wallet - plans/wp4.2-client-wallet-registration.md, "The signed
 * message": `{payloadJson, signature, recoveredAt}`, "re-verifiable offline forever". `payloadJson`
 * is `eip712.ts`'s `canonicalPayloadJson(domain, message)` output; `signature` is the 65-byte
 * `r||s||v` hex the wallet produced; `recoveredAt` is when the server independently verified it
 * (unix seconds).
 */
export interface ReceiptRecord {
  payloadJson: string;
  signature: string;
  recoveredAt: number;
}

/** Deterministic, fixed-key-order JSON encoding of the persisted receipt triple - the chain-ready
 * anchor point ("a deterministic `receiptHash = keccak256(canonical receipt encoding)` stored
 * alongside"). Field order is hardcoded (never derived from insertion order at a call site). */
export function canonicalReceiptEncoding(receipt: ReceiptRecord): string {
  return JSON.stringify({payloadJson: receipt.payloadJson, recoveredAt: receipt.recoveredAt, signature: receipt.signature});
}

export function computeReceiptHash(receipt: ReceiptRecord): Hex {
  return keccak256(toBytes(canonicalReceiptEncoding(receipt)));
}

/**
 * Parses a receipt's `payloadJson` back into its structured `{domain, message}` for on-screen
 * display - the Wallets panel's expanded receipt view (plans/wp4.2-client-wallet-registration.md
 * section 6's "receipt view", round-1 frontendDesignMatch fix: decoded fields through
 * AddressChip/HashCell rather than a raw JSON dump squeezed into a table cell). Tolerant of
 * malformed input (returns `null` rather than throwing) since this only feeds a read-only display -
 * never a security check, unlike `verifyReceiptExport`'s use of the same schema. A legitimately
 * persisted wallet's `payloadJson` always decodes (the server only ever writes what
 * `canonicalPayloadJson` produces); `null` is a defensive fallback for data that predates a schema
 * change or was hand-edited, not an expected path.
 */
export function decodeReceiptPayload(payloadJson: string): ClientRegistrationPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  const result = clientRegistrationPayloadSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * The exact shape a `Client.wallets[]` entry is exported as - both by the Wallets panel's
 * "download as JSON" button and by `scripts/verify-receipt.ts`'s expected input. One shared type
 * (and one shared serializer, `receiptExportJson`) for both sides is load-bearing: if the UI and
 * the script ever silently disagreed on field names or nesting, "receipt verification script
 * works" would pass in isolation while failing on every real download - see
 * `receipt.test.ts`'s round-trip test.
 */
export interface ReceiptExport {
  address: string;
  label?: string;
  registrationId: string;
  receipt: ReceiptRecord;
  receiptHash: string;
  issuedAt: number;
  blockNumber: number;
  registeredAt: number;
  revokedAt?: number;
}

const receiptRecordSchema = z.object({
  payloadJson: z.string(),
  signature: hexSignature65,
  recoveredAt: z.number(),
});

const receiptExportSchema = z.object({
  address: hexAddress,
  label: z.string().optional(),
  registrationId: z.string().min(1),
  receipt: receiptRecordSchema,
  receiptHash: hex32,
  issuedAt: z.number(),
  blockNumber: z.number(),
  registeredAt: z.number(),
  revokedAt: z.number().optional(),
});

/** Pretty-printed (human-inspectable) JSON for the download button and for hand-editing/piping
 * into `scripts/verify-receipt.ts`. Explicit field order, never object-spread, so the shape stays
 * identical regardless of how the caller happened to build the `ReceiptExport` value. */
export function receiptExportJson(entry: ReceiptExport): string {
  return JSON.stringify(
    {
      address: entry.address,
      ...(entry.label !== undefined ? {label: entry.label} : {}),
      registrationId: entry.registrationId,
      receipt: {
        payloadJson: entry.receipt.payloadJson,
        signature: entry.receipt.signature,
        recoveredAt: entry.receipt.recoveredAt,
      },
      receiptHash: entry.receiptHash,
      issuedAt: entry.issuedAt,
      blockNumber: entry.blockNumber,
      registeredAt: entry.registeredAt,
      ...(entry.revokedAt !== undefined ? {revokedAt: entry.revokedAt} : {}),
    },
    null,
    2,
  );
}

export type VerifyReceiptResult =
  | {
      ok: true;
      recoveredSigner: Address;
      /** Whether the recovered signer equals BOTH the export's own `address` field and the signed
       * message's own `wallet` field - the actual "is this a valid registration receipt" check. */
      addressMatches: boolean;
      receiptHashMatches: boolean;
      computedReceiptHash: Hex;
    }
  | {ok: false; error: string};

/**
 * Fully offline re-verification of an exported receipt: validates shape, independently recovers
 * the signer from `signature` over the exact domain/message `payloadJson` encodes, and
 * independently recomputes `receiptHash`. No network or database access anywhere in this
 * function - it is pure computation over the input value, which is what makes it "offline
 * forever" per the spec. Shared by `scripts/verify-receipt.ts` (which adds only file-IO/argv/exit
 * code around this) and this module's own unit test, so the CLI and the test can never drift
 * apart on what counts as valid.
 */
export async function verifyReceiptExport(input: unknown): Promise<VerifyReceiptResult> {
  const parsedExport = receiptExportSchema.safeParse(input);
  if (!parsedExport.success) {
    return {ok: false, error: `Not a recognizable receipt export: ${parsedExport.error.issues.map((i) => i.message).join("; ")}`};
  }
  const entry = parsedExport.data;

  let payloadJsonParsed: unknown;
  try {
    payloadJsonParsed = JSON.parse(entry.receipt.payloadJson);
  } catch {
    return {ok: false, error: "receipt.payloadJson is not valid JSON."};
  }
  const parsedPayload = clientRegistrationPayloadSchema.safeParse(payloadJsonParsed);
  if (!parsedPayload.success) {
    return {ok: false, error: `receipt.payloadJson is not a well-formed ClientRegistration payload: ${parsedPayload.error.issues.map((i) => i.message).join("; ")}`};
  }
  const payload = parsedPayload.data;

  // `clientRegistrationPayloadSchema` validates these as address/bytes32/decimal-string SHAPES
  // (regex-checked above, in `clientRegistrationPayloadSchema.safeParse`) but zod infers plain
  // `string`, not viem's branded `0x${string}` - the cast below narrows to what was already
  // proven, exactly like every other post-validation cast in this repo (e.g. the attestation
  // route's `body.signature as \`0x${string}\``).
  let recoveredSigner: Address;
  try {
    recoveredSigner = await recoverTypedDataAddress({
      domain: payload.domain as ClientRegistrationDomain,
      types: CLIENT_REGISTRATION_TYPES,
      primaryType: CLIENT_REGISTRATION_PRIMARY_TYPE,
      message: fromWireMessage(payload.message as ClientRegistrationMessageWire),
      signature: entry.receipt.signature as Hex,
    });
  } catch (err) {
    return {ok: false, error: `Could not recover a signer from the signature: ${err instanceof Error ? err.message : String(err)}`};
  }

  const computedReceiptHash = computeReceiptHash(entry.receipt);
  const addressMatches =
    recoveredSigner.toLowerCase() === entry.address.toLowerCase() && recoveredSigner.toLowerCase() === payload.message.wallet.toLowerCase();

  return {
    ok: true,
    recoveredSigner,
    addressMatches,
    receiptHashMatches: computedReceiptHash.toLowerCase() === entry.receiptHash.toLowerCase(),
    computedReceiptHash,
  };
}
