/** BN254 scalar field r (the SNARK scalar field — all reductions pin to this, NOT base q). */
export declare const FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export declare const DS_LEAF = 1n;
export declare const DS_NODE = 2n;
export declare const DS_BYTES = 3n;
export declare const DS_NULLIFIER = 4n;
export type Field = bigint;
/** Pinned circomlib Poseidon dispatched by arity (number of inputs). */
export declare function poseidon(inputs: Field[]): Field;
/** Big-endian decode of a byte array into a bigint. */
export declare function beToBigInt(bytes: Uint8Array): bigint;
/**
 * Inject a byte string into one field via the length-prefixed, 31-byte-chunked, domain-separated
 * fold (impl §1.2). Each 31-byte limb is < 2^248 < P so the be-decode is injective (no wraparound).
 * Used for variable-length components: keyPath and value.
 */
export declare function bytesToField(x: Uint8Array): Field;
/**
 * Pack bytes that fit in a single field directly (<= 31 bytes), big-endian (impl §11.2(a)):
 * salt(16B), addresses(uint160). NEVER folds — these are scalars, not variable-length strings.
 */
export declare function fieldFromScalarBytes(x: Uint8Array): Field;
/** A small unsigned integer (typeTag, indices) reduced into [0, P). */
export declare function fieldFromUint(n: bigint | number): Field;
/** Canonical 32-byte big-endian hex (0x-prefixed) of a field element. */
export declare function toHex32(x: Field): string;
/** Parse a 0x.. 32-byte hex back into a field element. */
export declare function fromHex32(h: string): Field;
//# sourceMappingURL=field.d.ts.map