import {describe, expect, it} from "vitest";
import {domainSeparator, getTypesForEIP712Domain, hashStruct, hashTypedData} from "viem";
import type {Address, Hex} from "viem";
import vectors from "./vectors/eip712-mobile-booking-vectors.json";

/**
 * Pins `tests/unit/vectors/eip712-mobile-booking-vectors.json` against drift.
 *
 * That file is a known-answer vector set for the WP4.4 "MobileBooking" EIP-712 struct
 * (plans/wp4.4-mobile-booking-protocol.md, section 2 "The wallet claim is SIGNED, never trusted
 * bare" - normative), generated once by a standalone script against this repo's own installed
 * viem (2.56.0) and then copied byte-for-byte into both dogtag-vet (here) and dogtag-ios
 * (`DogTagTests/Fixtures/`), mirroring exactly how the WP4.2 "ClientRegistration" vectors were made
 * (see `eip712ClientRegistration.vectors.test.ts`'s own doc comment). viem is the trusted reference
 * implementation on this side of that comparison, so this suite recomputes every vector's
 * `domainSeparator`/`structHash`/`digest` independently with viem's own `domainSeparator`/
 * `hashStruct`/`hashTypedData` and asserts byte-equality against the fixture's recorded `expected`
 * values - if the JSON file is ever hand-edited incorrectly, or a future viem upgrade silently
 * changes hash output, this fails loudly here before it can go unnoticed on the iOS side.
 *
 * `TYPES` below is a SEPARATE, hardcoded copy of the struct layout - deliberately not imported
 * from the generator script (kept outside this repo, under the session scratchpad that produced
 * the fixture) or from any shared module (no `src/lib` MobileBooking module exists yet - this
 * fixture and this test are the spec artifact that a future implementation gets vectored against,
 * the same order WP4.2 landed in: `eefa383` "EIP-712 client-registration known-answer vectors"
 * predates `0c68b08` "hand-rolled EIP-712 hashing for ClientRegistration" in this repo's history).
 * The two copies (this file's and any future production module's) can independently drift; that is
 * the point. If a future edit to the struct's field list (order, name, or Solidity type) is not
 * mirrored here, this test's own recomputation disagrees with the checked-in `expected` values and
 * fails - it does not just re-confirm whatever a generator or production module currently believes.
 *
 * JSON encoding note: `message.issuedAt` / `deadline` are uint64 in the struct and are stored as
 * DECIMAL STRINGS in the fixture (several vectors hit 2^64-1 = 18446744073709551615, past
 * `Number.MAX_SAFE_INTEGER`). Every parse below goes through `BigInt()`, never `Number()` - the
 * latter would silently round the two uint64-max vectors to the wrong value and this suite would
 * end up "passing" while checking nothing on exactly the vectors that matter most.
 */

const PRIMARY_TYPE = "MobileBooking" as const;
const TYPES = {
  MobileBooking: [
    {name: "clinic", type: "address"},
    {name: "bookingHash", type: "bytes32"},
    {name: "wallet", type: "address"},
    {name: "issuedAt", type: "uint64"},
    {name: "deadline", type: "uint64"},
  ],
} as const;

// Transcribed by hand from the spec's field list (not derived from `TYPES` above, and not derived
// from viem) - this is the one check in this file that is independent of both this file's own
// `TYPES` array AND of viem's hashing, so it alone catches a field-order/type-name mistake that
// happened to be made identically in both places.
const EXPECTED_MOBILE_BOOKING_TYPE_STRING = "MobileBooking(address clinic,bytes32 bookingHash,address wallet,uint64 issuedAt,uint64 deadline)";
// Same idea, for the domain: exactly these four fields, in this order, and - notably - no `salt`.
// Every domainSeparator recomputed below depends on viem's `getTypesForEIP712Domain` continuing to
// infer this same four-field list from a domain object shaped like ours; if a future viem upgrade
// changed that inference (field order, or started including `salt` for some reason), every
// per-vector recomputation below would fail with no hint that the DOMAIN type list, specifically,
// was the cause - this is the check that supplies that hint.
const EXPECTED_EIP712_DOMAIN_TYPE_STRING = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

function structTypeString(name: string, fields: ReadonlyArray<{name: string; type: string}>): string {
  return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

const UINT64_MAX = ((1n << 64n) - 1n).toString(10);

interface MobileBookingVector {
  name: string;
  description: string;
  domain: {name: string; version: string; chainId: number; verifyingContract: Address};
  message: {
    clinic: Address;
    bookingHash: Hex;
    wallet: Address;
    issuedAt: string;
    deadline: string;
  };
  expected: {domainSeparator: Hex; structHash: Hex; digest: Hex};
}

// The fixture's top-level value is a bare JSON array (see the generator script's header comment);
// `resolveJsonModule` + vitest's JSON handling give it back exactly as parsed, untyped.
const typedVectors = vectors as unknown as MobileBookingVector[];

describe("tests/unit/vectors/eip712-mobile-booking-vectors.json", () => {
  it("has at least 6 vectors", () => {
    expect(typedVectors.length).toBeGreaterThanOrEqual(6);
  });

  it("this file's independently-hardcoded MobileBooking type string matches the spec", () => {
    expect(structTypeString(PRIMARY_TYPE, TYPES.MobileBooking)).toBe(EXPECTED_MOBILE_BOOKING_TYPE_STRING);
  });

  it("viem still infers exactly the four spec'd EIP712Domain fields, in order, with no salt", () => {
    // A standalone representative domain, not read off `typedVectors[0]` - this check is about
    // viem's field-inference behavior for our domain shape in general, not about any one vector.
    const sampleDomain = {name: "DogTagMobileBooking", version: "1", chainId: 135, verifyingContract: "0x0000000000000000000000000000000000000000" as Address};
    const domainFields = getTypesForEIP712Domain({domain: sampleDomain});
    expect(structTypeString("EIP712Domain", domainFields)).toBe(EXPECTED_EIP712_DOMAIN_TYPE_STRING);
  });

  it.each(typedVectors.map((v) => [v.name, v] as const))(
    "%s: domainSeparator, structHash, and digest all byte-match viem's own recomputation",
    (_name, vector) => {
      const message = {
        clinic: vector.message.clinic,
        bookingHash: vector.message.bookingHash,
        wallet: vector.message.wallet,
        issuedAt: BigInt(vector.message.issuedAt),
        deadline: BigInt(vector.message.deadline),
      };

      const recomputedDomainSeparator = domainSeparator({domain: vector.domain});
      const recomputedStructHash = hashStruct({data: message, primaryType: PRIMARY_TYPE, types: TYPES});
      const recomputedDigest = hashTypedData({
        domain: vector.domain,
        types: TYPES,
        primaryType: PRIMARY_TYPE,
        message,
      });

      expect(recomputedDomainSeparator).toBe(vector.expected.domainSeparator);
      expect(recomputedStructHash).toBe(vector.expected.structHash);
      expect(recomputedDigest).toBe(vector.expected.digest);
    },
  );

  it("gives every vector a unique digest (no accidental duplicate or degenerate vector)", () => {
    const digests = new Set(typedVectors.map((v) => v.expected.digest));
    expect(digests.size).toBe(typedVectors.length);
  });

  it("covers uint64 max (2^64-1) on each of issuedAt and deadline individually", () => {
    expect(typedVectors.some((v) => v.message.issuedAt === UINT64_MAX)).toBe(true);
    expect(typedVectors.some((v) => v.message.deadline === UINT64_MAX)).toBe(true);
  });

  it("covers at least one vector where clinic (in-struct) and verifyingContract (domain) differ", () => {
    // Real sessions always set these equal (the spec's clinic clone address, "redundantly
    // in-struct"), but if every vector here also did, an implementation that read
    // `verifyingContract` for the struct's `clinic` field (or vice versa) would still pass every
    // other vector.
    const hasMismatch = typedVectors.some(
      (v) => v.message.clinic.toLowerCase() !== v.domain.verifyingContract.toLowerCase(),
    );
    expect(hasMismatch).toBe(true);
  });

  it("covers the zero address and the all-0xff address in both the clinic/verifyingContract and wallet slots", () => {
    const zero = "0x0000000000000000000000000000000000000000";
    const max = "0xffffffffffffffffffffffffffffffffffffffff";
    const lower = (a: string) => a.toLowerCase();
    expect(typedVectors.some((v) => lower(v.message.clinic) === zero)).toBe(true);
    expect(typedVectors.some((v) => lower(v.message.clinic) === max)).toBe(true);
    expect(typedVectors.some((v) => lower(v.message.wallet) === zero)).toBe(true);
    expect(typedVectors.some((v) => lower(v.message.wallet) === max)).toBe(true);
  });

  it("varies clinic and wallet addresses, and bookingHash, across every vector", () => {
    const clinics = new Set(typedVectors.map((v) => v.message.clinic.toLowerCase()));
    const wallets = new Set(typedVectors.map((v) => v.message.wallet.toLowerCase()));
    const bookingHashes = new Set(typedVectors.map((v) => v.message.bookingHash.toLowerCase()));
    expect(clinics.size).toBe(typedVectors.length);
    expect(wallets.size).toBe(typedVectors.length);
    expect(bookingHashes.size).toBe(typedVectors.length);
  });
});
