import {describe, expect, it} from "vitest";
import {concat, hashStruct, hashTypedData, keccak256, pad, toBytes, toHex, type Address, type Hex} from "viem";
import {
  DELEGATION_CLAIM_PRIMARY_TYPE,
  DELEGATION_CLAIM_TYPES,
  buildDelegationClaimDomain,
  type DelegationClaimMessage,
} from "@/lib/delegation/eip712";

/**
 * `DelegationClaim`'s EIP-712 typeHash preimage, pinned - `docs/DELEGATION.md` section 4.3 step 4
 * / `specs/vet-public-api.yaml`'s `postDelegationSessionComplete` description, both normative:
 * "no spaces: this is the exact `encodeType` string whose keccak256 is the typeHash". A field
 * renamed, reordered, or re-typed in `DELEGATION_CLAIM_TYPES` (`src/lib/delegation/eip712.ts`)
 * changes the recovered signer for every real signature - this test is the bite for that class of
 * bug, not merely a shape check.
 */
const CANONICAL_ENCODE_TYPE_STRING =
  "DelegationClaim(address clinic,uint256 dogTagIdField,bytes32 commitment,bytes32 registrationId,address wallet,uint64 issuedAt,uint64 blockNumber,uint64 deadline)";

/** Independently pinned (not derived from viem's own, unexported `encodeType`/`hashStruct`
 * internals - viem's package.json exposes no subpath for either) via a one-time probe: `keccak256`
 * of the literal string above. */
const EXPECTED_TYPE_HASH = "0x135d9a5f5cfde1b184e055e33d7211eaacce7a77d70daf3f26f6d73852d2c1af" as const;

/** EIP-712 `encodeType` for a struct with no nested-struct dependencies (every `DelegationClaim`
 * field is a primitive) is just `${primaryType}(${fields.map(f => \`${f.type} ${f.name}\`).join(",")})`
 * - reimplemented here from scratch (never imported from viem, which does not export it at any
 * public subpath) and walked over the REAL, PRODUCTION `DELEGATION_CLAIM_TYPES` array, so a
 * field-order/name/type edit in `eip712.ts` changes this test's own derived string, not just the
 * hand-maintained doc comments that cite it. */
function encodeTypeFromProductionTypes(): string {
  const fields = DELEGATION_CLAIM_TYPES.DelegationClaim;
  return `${DELEGATION_CLAIM_PRIMARY_TYPE}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

/** One 32-byte EIP-712 field encoding, per field `type` - independent of viem's own (unexported)
 * `encodeData`: `address` left-pads to 32 bytes, `bytes32` passes through, `uint64`/`uint256`
 * left-pad their big-endian value to 32 bytes. Every `DelegationClaim` field is one of these three
 * shapes (no dynamic `string`/`bytes`, no nested struct), so this is a complete encoder for it. */
function encodeFieldValue(type: string, value: Address | Hex | bigint): Hex {
  if (type === "address") return pad(value as Address, {size: 32});
  if (type === "bytes32") return value as Hex;
  if (type === "uint64" || type === "uint256") return pad(toHex(value as bigint), {size: 32});
  throw new Error(`encodeFieldValue: unhandled type ${type}`);
}

/** The full EIP-712 struct hash (`keccak256(typeHash || encodeData(message))`), computed from
 * scratch by walking the REAL `DELEGATION_CLAIM_TYPES` field list in order and encoding each named
 * field off `message` - independent of viem's own `hashStruct`, so comparing the two below is a
 * genuine cross-implementation check, not a tautology. */
function independentStructHash(message: DelegationClaimMessage): Hex {
  const typeHash = keccak256(toBytes(encodeTypeFromProductionTypes()));
  const fields = DELEGATION_CLAIM_TYPES.DelegationClaim;
  const encodedFields = fields.map((f) => encodeFieldValue(f.type, message[f.name as keyof DelegationClaimMessage]));
  return keccak256(concat([typeHash, ...encodedFields]));
}

const SAMPLE_MESSAGE: DelegationClaimMessage = {
  clinic: "0x1111111111111111111111111111111111111111",
  dogTagIdField: 42n,
  commitment: `0x${"22".repeat(32)}` as Hex,
  registrationId: `0x${"33".repeat(16)}${"0".repeat(32)}` as Hex,
  wallet: "0x4444444444444444444444444444444444444444",
  issuedAt: 1000n,
  blockNumber: 2000n,
  deadline: 3000n,
};

describe("DelegationClaim EIP-712 typeHash and struct hash", () => {
  it("DELEGATION_CLAIM_TYPES's own field list reproduces the documented encodeType string byte-for-byte", () => {
    expect(encodeTypeFromProductionTypes()).toBe(CANONICAL_ENCODE_TYPE_STRING);
  });

  it("keccak256 of the canonical encodeType string equals the pinned typeHash", () => {
    expect(keccak256(toBytes(CANONICAL_ENCODE_TYPE_STRING))).toBe(EXPECTED_TYPE_HASH);
  });

  it("an independent, from-scratch struct-hash derivation over the production types agrees with viem's own hashStruct", () => {
    const mine = independentStructHash(SAMPLE_MESSAGE);
    const viemsOwn = hashStruct({
      data: SAMPLE_MESSAGE,
      primaryType: DELEGATION_CLAIM_PRIMARY_TYPE,
      types: DELEGATION_CLAIM_TYPES,
    });
    expect(mine).toBe(viemsOwn);
  });

  it("hashTypedData (the function every real sign/recover call in this app uses) is deterministic and domain-bound", () => {
    const domain = buildDelegationClaimDomain(135, "0x1111111111111111111111111111111111111111");
    const hash = hashTypedData({domain, types: DELEGATION_CLAIM_TYPES, primaryType: DELEGATION_CLAIM_PRIMARY_TYPE, message: SAMPLE_MESSAGE});
    // A different chainId (a different EIP-712 domain separator) must change the final hash -
    // proves the domain is genuinely folded in, not merely accepted and ignored.
    const otherChainDomain = buildDelegationClaimDomain(1, "0x1111111111111111111111111111111111111111");
    const otherHash = hashTypedData({
      domain: otherChainDomain,
      types: DELEGATION_CLAIM_TYPES,
      primaryType: DELEGATION_CLAIM_PRIMARY_TYPE,
      message: SAMPLE_MESSAGE,
    });
    expect(hash).not.toBe(otherHash);
  });
});
