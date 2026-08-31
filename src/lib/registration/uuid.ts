import {toBytes, type Hex} from "viem";

/** Strips dashes from a UUID string and validates it decodes to exactly 16 bytes. Deliberately
 * does NOT check the v4 version/variant nibbles - `plans/wp4.2-client-wallet-registration.md`
 * calls `registrationId` "the random UUID (v4)" as a description of where a real one comes from
 * (`randomUUID()`), not a bit pattern these encoding functions must re-validate; the shared EIP-712
 * vector fixture's `registrationId` values are arbitrary random bytes formatted into UUID shape,
 * not real v4 output, and a strict check here would reject them. */
function uuidHexNoDashes(uuid: string): string {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`Not a UUID (expected 32 hex chars after removing dashes): ${uuid}`);
  return hex.toLowerCase();
}

/** The UUID's raw 16 bytes, for `clientHash`'s `|| uuidBytes16` term (plans/wp4.2-client-wallet-
 * registration.md, "The signed message"). */
export function uuidToBytes16(uuid: string): Uint8Array {
  return toBytes(`0x${uuidHexNoDashes(uuid)}` as Hex);
}

/** The UUID's 16 bytes, right-padded with 16 zero bytes to a full bytes32 - the EIP-712 struct's
 * `registrationId` field ("the random UUID (v4), right-padded to 32 bytes, hex"). Right-padded,
 * not left-padded like a numeric value would be: the UUID's own bytes stay at the front. */
export function registrationIdToHex32(uuid: string): Hex {
  return `0x${uuidHexNoDashes(uuid)}${"0".repeat(32)}` as Hex;
}
