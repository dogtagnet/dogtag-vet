import {describe, expect, it} from "vitest";
import {buildMerkle, hashLeaf, hexToBytes, toHex32, TypeTag, type TypedScalar} from "@dogtag/standard";
import {buildDelegationCoOwnerBundle} from "@/lib/delegation/bundle";
import type {ExportedArtifactRow} from "@/lib/tags/exportFlow";

/** A genuine, hashLeaf/buildMerkle-verifiable (leaves, reservedLeafHashes, root) triple - same
 * fixture-building convention as `tests/unit/tags/exportFlow.test.ts`'s own `buildVerifiableFixture`
 * (this module's `buildDelegationCoOwnerBundle` self-checks with `verifyRedactedArtifact` via the
 * SAME `buildRedactedExportPayload` that function does, so an arbitrary root fails closed here too). */
function buildVerifiableFixture(): {leaves: {keyPath: string; saltHex: string; tag: TypeTag; value: string}[]; reservedLeafHashes: string[]; root: string} {
  const salt = (n: number) => new Uint8Array(16).fill(n);
  const saltHexOf = (n: number) => ("0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
  const leaves = [
    {keyPath: "credentialSubject.name", saltHex: saltHexOf(11), tag: TypeTag.String, value: "Rex"},
    {keyPath: "credentialSubject.species", saltHex: saltHexOf(12), tag: TypeTag.String, value: "dog"},
  ];
  const reservedLeafHashes = [
    toHex32(hashLeaf("owner.address", salt(201), {tag: TypeTag.Bytes, value: new Uint8Array([1])} as TypedScalar)),
    toHex32(hashLeaf("owner.consentKey", salt(202), {tag: TypeTag.Bytes, value: new Uint8Array([2])} as TypedScalar)),
    toHex32(hashLeaf("owner.secret", salt(203), {tag: TypeTag.Bytes, value: new Uint8Array([3])} as TypedScalar)),
  ];
  const reservedFields = reservedLeafHashes.map((h) => BigInt(h));
  const leafFields = leaves.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), {tag: l.tag, value: l.value} as TypedScalar));
  const root = toHex32(buildMerkle([...reservedFields, ...leafFields]).root);
  return {leaves, reservedLeafHashes, root};
}

const FIXTURE = buildVerifiableFixture();

function newArtifactFixture(overrides?: Partial<ExportedArtifactRow>): ExportedArtifactRow {
  return {
    protocolVersion: "dogtag-v2/1",
    dogTagIdDec: "42",
    dogTagIdField: "999999",
    root: FIXTURE.root,
    leaves: FIXTURE.leaves,
    obfuscatedLeafHashes: [],
    reservedLeafHashes: FIXTURE.reservedLeafHashes,
    issuerClone: "0x5bd5048125f223100a2753a740f34d044ab493b",
    active: true,
    ...overrides,
  };
}

const SIXTEEN_ZERO_LEAVES = Array.from({length: 16}, () => `0x${"0".repeat(64)}`);

describe("buildDelegationCoOwnerBundle", () => {
  it("carries every field the yaml's DelegationCoOwnerBundle.required list names", () => {
    const result = buildDelegationCoOwnerBundle(newArtifactFixture(), {
      delegationLeaves: SIXTEEN_ZERO_LEAVES,
      chainId: 135,
      petName: "Blaze",
      clinicName: "Test Clinic",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // specs/vet-public-api.yaml DelegationCoOwnerBundle.required, verbatim:
    const required = [
      "protocolVersion",
      "dogTagIdField",
      "root",
      "disclosed",
      "obfuscatedLeafHashes",
      "reservedLeafHashes",
      "delegationLeaves",
      "issuerClone",
      "chainId",
      "petName",
      "clinicName",
    ] as const;
    const bundleAsRecord = result.bundle as unknown as Record<string, unknown>;
    for (const key of required) {
      expect(result.bundle).toHaveProperty(key);
      expect(bundleAsRecord[key]).not.toBeUndefined();
    }
  });

  it("never carries any owner private material - only public fields are ever assignable on this type", () => {
    const result = buildDelegationCoOwnerBundle(newArtifactFixture(), {
      delegationLeaves: SIXTEEN_ZERO_LEAVES,
      chainId: 135,
      petName: "Blaze",
      clinicName: "Test Clinic",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = Object.keys(result.bundle);
    for (const forbidden of ["ownerSecret", "consentKey", "seed", "ownerSalt", "secretSalt"]) {
      expect(keys.some((k) => k.toLowerCase().includes(forbidden.toLowerCase()))).toBe(false);
    }
  });

  it("delegationLeaves is exactly the live chain read passed in, never reconstructed", () => {
    const liveLeaves = [`0x${"ab".repeat(32)}`, ...SIXTEEN_ZERO_LEAVES.slice(1)];
    const result = buildDelegationCoOwnerBundle(newArtifactFixture(), {
      delegationLeaves: liveLeaves,
      chainId: 135,
      petName: "Blaze",
      clinicName: "Test Clinic",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bundle.delegationLeaves).toEqual(liveLeaves);
  });

  it("fails closed (self-check) when the artifact's own leaves do not actually recompute the claimed root", () => {
    const result = buildDelegationCoOwnerBundle(newArtifactFixture({root: `0x${"9".repeat(64)}`}), {
      delegationLeaves: SIXTEEN_ZERO_LEAVES,
      chainId: 135,
      petName: "Blaze",
      clinicName: "Test Clinic",
    });
    expect(result.ok).toBe(false);
  });

  it("a masked (partial-custody) artifact still produces a bundle whose obfuscatedLeafHashes reflect it", () => {
    const maskedHash = toHex32(hashLeaf(FIXTURE.leaves[1]!.keyPath, hexToBytes(FIXTURE.leaves[1]!.saltHex), {tag: FIXTURE.leaves[1]!.tag, value: FIXTURE.leaves[1]!.value} as TypedScalar));
    const result = buildDelegationCoOwnerBundle(newArtifactFixture({leaves: [FIXTURE.leaves[0]!], obfuscatedLeafHashes: [maskedHash]}), {
      delegationLeaves: SIXTEEN_ZERO_LEAVES,
      chainId: 135,
      petName: "Blaze",
      clinicName: "Test Clinic",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.disclosed).toHaveLength(1);
      expect(result.bundle.obfuscatedLeafHashes).toEqual([maskedHash]);
    }
  });
});
