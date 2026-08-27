import { type TypedScalar } from "./types.js";
/**
 * Pinned Unicode version for NFC normalization (A3). Node's `String.prototype.normalize` uses the
 * ICU bundled with the runtime; CI pins the Node version so the Unicode data is fixed. Stated here
 * so the Rust SDK (`unicode-normalization`) targets the same Unicode major version.
 */
export declare const UNICODE_VERSION = "15.1";
/** NFC-normalize and reject unpaired surrogates (A3). */
export declare function nfc(s: string): string;
/** Canonical integer string: no leading zeros, "-0" -> "0" (A1). */
export declare function canonicalInteger(s: string): string;
/**
 * Canonical decimal string over the INPUT STRING, never a float (A1/A2):
 * strip fractional trailing zeros, drop a trailing ".", map "-0" -> "0",
 * reject exponent/whitespace/"+".
 */
export declare function canonicalDecimal(s: string): string;
/** Hard guard: a native float must never reach the wrap boundary (A2). */
export declare function assertNotFloat(v: unknown): void;
/** encodeValue(typeTag, value) -> canonical bytes (impl §1.1). */
export declare function encodeValue(s: TypedScalar): Uint8Array;
/** Canonical string form stored in `data` (self-describing): the value as a string. */
export declare function asString(s: TypedScalar): string;
export declare function bytesToHex(b: Uint8Array): string;
export declare function hexToBytes(h: string): Uint8Array;
//# sourceMappingURL=encode.d.ts.map