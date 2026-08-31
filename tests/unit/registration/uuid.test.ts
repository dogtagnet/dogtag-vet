import {describe, expect, it} from "vitest";
import {registrationIdToHex32, uuidToBytes16} from "@/lib/registration/uuid";
import vectors from "../../../protocol/specs/eip712-client-registration-vectors.json";

interface ClientRegistrationVector {
  message: {registrationId: string};
}

const typedVectors = vectors as unknown as ClientRegistrationVector[];

/** First 32 hex chars (16 bytes) of a vector's `registrationId` hex32, reformatted as a dashed
 * UUID string - the inverse of what `registrationIdToHex32` does to its input, used ONLY to prove
 * the round trip below. Not exported by `uuid.ts` itself: production code only ever goes
 * UUID -> hex, never the other way. */
function hex32ToUuidString(hex32: string): string {
  const hex = hex32.slice(2, 34); // drop "0x", keep the first 32 hex chars (16 bytes)
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

describe("uuidToBytes16", () => {
  it("returns exactly 16 bytes", () => {
    expect(uuidToBytes16("8fd81415-a95c-9b04-c6f9-08ec7d0bcf3a")).toHaveLength(16);
  });

  it("strips dashes and preserves byte order", () => {
    const bytes = uuidToBytes16("00010203-0405-0607-0809-0a0b0c0d0e0f");
    expect(Array.from(bytes)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it("is case-insensitive", () => {
    expect(Array.from(uuidToBytes16("ABCDEF01-2345-6789-ABCD-EF0123456789"))).toEqual(
      Array.from(uuidToBytes16("abcdef01-2345-6789-abcd-ef0123456789")),
    );
  });

  it("rejects a value that is not a UUID-shaped 32 hex chars", () => {
    expect(() => uuidToBytes16("not-a-uuid")).toThrow();
    expect(() => uuidToBytes16("8fd81415-a95c-9b04-c6f9-08ec7d0bcf3")).toThrow(); // one hex char short
  });

  it("does not enforce the v4 version/variant nibbles - fixture registrationIds are raw random bytes, not real v4 UUIDs", () => {
    // The vectors file's registrationId fixtures were generated as arbitrary random bytes
    // formatted into UUID shape, not real `crypto.randomUUID()` output - several fail a strict v4
    // check (the version nibble, third group's first hex digit, is not always "4"). Only the byte
    // count/shape matters here, matching `plans/wp4.2-client-wallet-registration.md`'s own use of
    // "the random UUID (v4)" as a description of where a REAL registrationId comes from
    // (`randomUUID()`), not a format the hashing/encoding functions themselves must re-validate.
    const vector = typedVectors[0];
    if (!vector) throw new Error("expected at least one vector");
    const uuidString = hex32ToUuidString(vector.message.registrationId);
    expect(() => uuidToBytes16(uuidString)).not.toThrow();
  });
});

describe("registrationIdToHex32", () => {
  it("right-pads the UUID's 16 bytes with 16 zero bytes to a 32-byte 0x hex value", () => {
    const hex32 = registrationIdToHex32("00010203-0405-0607-0809-0a0b0c0d0e0f");
    expect(hex32).toBe("0x000102030405060708090a0b0c0d0e0f00000000000000000000000000000000".slice(0, 66));
    expect(hex32).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("round-trips byte-for-byte against every UUID-shaped vector's own registrationId encoding", () => {
    // One vector ("bytes32-edges-and-different-chain") deliberately sets `registrationId` to the
    // all-0xff bit pattern - its own `description` calls this out as "a pure bit-pattern edge
    // case, not a right-padded-UUID shape", there specifically to prove the EIP-712 hashing itself
    // doesn't care whether this slot looks like a padded UUID. Filtering to vectors whose low 16
    // bytes actually ARE zero (the structural signature of "raw UUID bytes then right-pad") keeps
    // this round-trip check meaningful without hardcoding that one vector's name.
    const uuidShaped = typedVectors.filter((v) => /0{32}$/.test(v.message.registrationId));
    expect(uuidShaped.length).toBeGreaterThan(0);
    for (const vector of uuidShaped) {
      const uuidString = hex32ToUuidString(vector.message.registrationId);
      expect(registrationIdToHex32(uuidString)).toBe(vector.message.registrationId.toLowerCase());
    }
  });

  it("pads on the RIGHT, not the left - the low-order 16 bytes are zero, not the high-order ones", () => {
    const hex32 = registrationIdToHex32("ffffffff-ffff-ffff-ffff-ffffffffffff");
    expect(hex32.slice(2, 34)).toBe("f".repeat(32)); // the UUID's own bytes, untouched, at the FRONT
    expect(hex32.slice(34)).toBe("0".repeat(32)); // zero padding at the END
  });
});
