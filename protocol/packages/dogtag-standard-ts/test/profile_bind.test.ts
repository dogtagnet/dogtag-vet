// Unit coverage for `profileBind.ts` - the vet-side bind-commitment check (D1/M5), the fail-closed
// mirror of `verify_leaf_commitment` in the v1 vet API. Builds a small tree in-test with
// `hashLeaf` + `buildMerkle` (mirroring the real device-side tree shape: 3 reserved owner-control
// hashes + N opened attribute leaves) and exercises every accept/reject case the WP2 spec calls for.
import {describe, it, expect} from "vitest";
import {TypeTag, hashLeaf, buildMerkle, toHex32, hexToBytes, type TypedScalar} from "../src/index.js";
import {verifyLeafCommitment, dogTagIdField, type OpenedLeaf} from "../src/profileBind.js";

function salt(n: number): Uint8Array {
  return new Uint8Array(16).fill(n);
}

function opened(keyPath: string, saltByte: number, tag: TypeTag, value: string): OpenedLeaf {
  return {keyPath, saltHex: bytesToHex(salt(saltByte)), tag, value};
}

function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The 3 reserved owner-control leaves, as opaque hashes the vet cannot recompute (they commit to
 * owner secrets that never leave the device) - just distinct field elements for this test. */
function reservedHashes(): string[] {
  return [
    hashLeaf("owner.address", salt(201), {tag: TypeTag.Bytes, value: new Uint8Array([1])} as TypedScalar),
    hashLeaf("owner.consentKey", salt(202), {tag: TypeTag.Bytes, value: new Uint8Array([2])} as TypedScalar),
    hashLeaf("owner.secret", salt(203), {tag: TypeTag.Bytes, value: new Uint8Array([3])} as TypedScalar),
  ].map(toHex32);
}

function identityOpenings(): OpenedLeaf[] {
  return [
    opened("owner.identity.fullName", 21, TypeTag.String, "Alice Owner"),
    opened("owner.identity.country", 22, TypeTag.String, "GB"),
    opened("owner.identity.docNumber", 23, TypeTag.String, "PASSPORT-123"),
  ];
}

function petOpenings(): OpenedLeaf[] {
  return [
    opened("credentialSubject.name", 7, TypeTag.String, "Rex"),
    opened("credentialSubject.breedLabel", 9, TypeTag.String, "Shiba Inu"),
  ];
}

/** Build the real root from a set of openings + reserved hashes, exactly as `verifyLeafCommitment`
 * itself does, so tests can assert the accept path against a genuinely-computed root. */
function computeRoot(reserved: string[], leaves: OpenedLeaf[]): string {
  const reservedFields = reserved.map((h) => BigInt(h));
  const leafFields = leaves.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalarOf(l)));
  return toHex32(buildMerkle([...reservedFields, ...leafFields]).root);
}

function scalarOf(l: OpenedLeaf): TypedScalar {
  switch (l.tag) {
    case TypeTag.Null:
      return {tag: TypeTag.Null, value: null};
    case TypeTag.Bool:
      return {tag: TypeTag.Bool, value: l.value === "true"};
    case TypeTag.Bytes:
      return {tag: TypeTag.Bytes, value: new Uint8Array()};
    default:
      return {tag: l.tag, value: l.value} as TypedScalar;
  }
}

describe("verifyLeafCommitment - accept", () => {
  it("accepts a genuine tree: 3 reserved + pet + identity openings, identity matches expected", () => {
    const reserved = reservedHashes();
    const leaves = [...petOpenings(), ...identityOpenings()];
    const root = computeRoot(reserved, leaves);
    expect(
      verifyLeafCommitment({
        root,
        leaves,
        reservedLeafHashes: reserved,
        expectedIdentityLeaves: identityOpenings(),
      }),
    ).toBe(true);
  });

  it("accepts a tree with no identity leaves when none are expected", () => {
    const reserved = reservedHashes();
    const leaves = petOpenings();
    const root = computeRoot(reserved, leaves);
    expect(
      verifyLeafCommitment({root, leaves, reservedLeafHashes: reserved, expectedIdentityLeaves: []}),
    ).toBe(true);
  });
});

describe("verifyLeafCommitment - reject", () => {
  it("rejects an altered value (root no longer matches)", () => {
    const reserved = reservedHashes();
    const leaves = [...petOpenings(), ...identityOpenings()];
    const root = computeRoot(reserved, leaves);
    const altered = leaves.map((l) => (l.keyPath === "credentialSubject.name" ? {...l, value: "Fido"} : l));
    expect(
      verifyLeafCommitment({root, leaves: altered, reservedLeafHashes: reserved, expectedIdentityLeaves: identityOpenings()}),
    ).toBe(false);
  });

  it("rejects a dropped identity leaf (posted set no longer matches expected)", () => {
    const reserved = reservedHashes();
    const full = [...petOpenings(), ...identityOpenings()];
    const dropped = full.filter((l) => l.keyPath !== "owner.identity.docNumber");
    const root = computeRoot(reserved, dropped); // the owner's tree really did drop it
    expect(
      verifyLeafCommitment({root, leaves: dropped, reservedLeafHashes: reserved, expectedIdentityLeaves: identityOpenings()}),
    ).toBe(false);
  });

  it("rejects an injected extra identity leaf not in the expected set", () => {
    const reserved = reservedHashes();
    const injected = [...petOpenings(), ...identityOpenings(), opened("owner.identity.extra", 24, TypeTag.String, "sneaky")];
    const root = computeRoot(reserved, injected);
    expect(
      verifyLeafCommitment({root, leaves: injected, reservedLeafHashes: reserved, expectedIdentityLeaves: identityOpenings()}),
    ).toBe(false);
  });

  it("rejects a posted leaf that duplicates an existing keyPath", () => {
    const reserved = reservedHashes();
    const dup = [...petOpenings(), ...identityOpenings(), opened("owner.identity.country", 22, TypeTag.String, "GB")];
    // Two entries share the identical keyPath -> the duplicate-keyPath guard fires (before the
    // identity set is even compared), so this pins that guard rather than the multiset compare.
    const root = computeRoot(reserved, dup);
    expect(
      verifyLeafCommitment({root, leaves: dup, reservedLeafHashes: reserved, expectedIdentityLeaves: identityOpenings()}),
    ).toBe(false);
  });

  it("rejects when the EXPECTED identity set itself has a duplicate (multiset, not set-membership)", () => {
    // No duplicate on the posted side (so the duplicate-keyPath guard never fires) - the posted
    // identity openings are a proper 3-element set, but `expectedIdentityLeaves` names one of them
    // twice, so the two multisets can never have equal length. This is the case that actually
    // exercises `sameMultiset` rather than the earlier keyPath guard.
    const reserved = reservedHashes();
    const leaves = [...petOpenings(), ...identityOpenings()];
    const root = computeRoot(reserved, leaves);
    const expectedWithDuplicate = [...identityOpenings(), opened("owner.identity.country", 22, TypeTag.String, "GB")];
    expect(
      verifyLeafCommitment({root, leaves, reservedLeafHashes: reserved, expectedIdentityLeaves: expectedWithDuplicate}),
    ).toBe(false);
  });

  it("rejects a wrong root", () => {
    const reserved = reservedHashes();
    const leaves = [...petOpenings(), ...identityOpenings()];
    computeRoot(reserved, leaves); // establishes the genuine root is well-defined
    const wrongRoot = toHex32(999999n);
    expect(
      verifyLeafCommitment({root: wrongRoot, leaves, reservedLeafHashes: reserved, expectedIdentityLeaves: identityOpenings()}),
    ).toBe(false);
  });

  it("rejects 2 reserved hashes", () => {
    const reserved = reservedHashes().slice(0, 2);
    const leaves = petOpenings();
    expect(
      verifyLeafCommitment({root: toHex32(1n), leaves, reservedLeafHashes: reserved, expectedIdentityLeaves: []}),
    ).toBe(false);
  });

  it("rejects 4 reserved hashes", () => {
    const reserved = [...reservedHashes(), toHex32(42n)];
    const leaves = petOpenings();
    expect(
      verifyLeafCommitment({root: toHex32(1n), leaves, reservedLeafHashes: reserved, expectedIdentityLeaves: []}),
    ).toBe(false);
  });

  it("rejects more than 64 total leaves (3 reserved + 62 opened)", () => {
    const reserved = reservedHashes();
    const many: OpenedLeaf[] = Array.from({length: 62}, (_, i) => opened(`credentialSubject.extra[${i}]`, (i % 250) + 1, TypeTag.String, `v${i}`));
    const root = computeRoot(reserved, many.slice(0, 61)); // irrelevant: cap check runs first
    expect(
      verifyLeafCommitment({root, leaves: many, reservedLeafHashes: reserved, expectedIdentityLeaves: []}),
    ).toBe(false);
  });

  it("accepts exactly at the 64-leaf cap (3 reserved + 61 opened)", () => {
    const reserved = reservedHashes();
    const many: OpenedLeaf[] = Array.from({length: 61}, (_, i) => opened(`credentialSubject.extra[${i}]`, (i % 250) + 1, TypeTag.String, `v${i}`));
    const root = computeRoot(reserved, many);
    expect(
      verifyLeafCommitment({root, leaves: many, reservedLeafHashes: reserved, expectedIdentityLeaves: []}),
    ).toBe(true);
  });

  it("rejects an opened leaf that names a reserved owner-control keyPath", () => {
    const reserved = reservedHashes();
    const sneaky = [...petOpenings(), opened("owner.secret", 5, TypeTag.String, "x")];
    const root = computeRoot(reserved, sneaky);
    expect(
      verifyLeafCommitment({root, leaves: sneaky, reservedLeafHashes: reserved, expectedIdentityLeaves: []}),
    ).toBe(false);
  });

  it("rejects a malformed opening (bad salt hex) fail-closed rather than throwing", () => {
    const reserved = reservedHashes();
    const leaves = [{keyPath: "credentialSubject.name", saltHex: "0xzz", tag: TypeTag.String, value: "Rex"}];
    expect(() =>
      verifyLeafCommitment({root: toHex32(1n), leaves, reservedLeafHashes: reserved, expectedIdentityLeaves: []}),
    ).not.toThrow();
    expect(
      verifyLeafCommitment({root: toHex32(1n), leaves, reservedLeafHashes: reserved, expectedIdentityLeaves: []}),
    ).toBe(false);
  });
});

describe("dogTagIdField - parity fixture against the Rust field-hash bin", () => {
  // Generated by running `crates/dogtag-standard-rs/src/bin/field-hash.rs` (the pre-existing
  // `field_of_value(Integer(dec))` printer) directly - cross-checked here so a drift in either
  // language's bytesToField/canonicalInteger composition is caught.
  const FIXTURES: Array<[string, string]> = [
    ["424242", "19282080935305080861096842252900215298393603684181619512414474199363734335896"],
    ["0", "5303345339220914292775686013608821825994062894759722744871619979296614690413"],
    ["1", "8234027165855484825059457262856023715249120623833441764963510593320928109984"],
    [
      "999999999999999999999999999999",
      "1637613868883240734952035150879231368259315556158216942873231889973862081008",
    ],
  ];

  for (const [dec, expected] of FIXTURES) {
    it(`dogTagIdField(${dec}) matches the Rust fixture`, () => {
      expect(dogTagIdField(dec).toString()).toBe(expected);
    });
  }

  it("canonicalizes the handle first (leading zeros, \"-0\") like field_of_value(Integer(_))", () => {
    expect(dogTagIdField("0").toString()).toBe(dogTagIdField("-0").toString());
  });

  it("rejects a non-canonical integer string", () => {
    expect(() => dogTagIdField("01")).toThrow();
    expect(() => dogTagIdField("1.5")).toThrow();
  });
});
