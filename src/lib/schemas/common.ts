import {z} from "zod";

/** Every protocol amount (weights, prices, token base units) is a canonical decimal string, never
 * a native float - see profileBind.ts / encode.ts in @dogtag/standard. This schema only checks
 * shape (optional leading `-`, digits, optional single `.` with digits); callers that need a
 * non-negative integer string layer a `.regex(/^\d+$/)` refinement on top. */
export const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "Must be a decimal number as a string, e.g. \"12.50\"");

export const nonNegativeIntegerString = z.string().regex(/^\d+$/, "Must be a non-negative integer string");

export const hexAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Must be a 0x-prefixed 40-hex-character address");

/** `hexAddress`, normalized to lowercase on parse - for fields this app itself owns the canonical
 * casing of (comparison/dedup by exact string equality, e.g. `Staff.walletAddress` matched against
 * on-chain `operators(address)` reads - WP4.7 D4), as opposed to `hexAddress` alone, which several
 * existing fields (`ClinicSettings.entityAccount`/`cloneAddress`/`operatorWallet`) deliberately keep
 * un-transformed to preserve whatever checksum casing the wallet/chain itself returned. */
export const lowercaseHexAddress = hexAddress.transform((v) => v.toLowerCase());

export const hex32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "Must be a 0x-prefixed 32-byte hex value");

export const hex16Salt = z
  .string()
  .regex(/^0x[0-9a-fA-F]{32}$/, "Must be a 0x-prefixed 16-byte hex salt");

export const hexToken32 = z
  .string()
  .regex(/^[0-9a-f]{32}$/, "Must be 32 lowercase hex characters");

/** A 65-byte `r||s||v` ECDSA signature, 0x-prefixed hex - the shape every `recoverTypedDataAddress`
 * call site in this repo expects (`viem`'s own signature format). */
export const hexSignature65 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/, "Must be a 0x-prefixed 65-byte (130 hex char) signature");

export const unixSeconds = z.number().int().nonnegative();

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be an ISO date (YYYY-MM-DD)");

export const moneySchema = z.object({
  amount: decimalString,
  currency: z.string().length(3),
});

export const paymentChainKey = z.enum(["roax"]);
export const paymentToken = z.enum(["PLASMA", "RUSD"]);
