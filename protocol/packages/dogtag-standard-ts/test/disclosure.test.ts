// Unit coverage for `disclosure.ts` - the verification half of `ProfileDisclosure` (D1), the
// fail-closed mirror of `crates/dogtag-standard-rs/src/disclosure.rs::verify_profile_disclosure`.
// Building a disclosure stays mobile-side; this test file plays that role LOCALLY (via hashLeaf +
// buildMerkle + merkleProof, the same primitives the device uses) purely so it can hand
// `verifyProfileDisclosure` a well-formed envelope to check.
import {describe, it, expect} from "vitest";
import {TypeTag, hashLeaf, buildMerkle, merkleProof, toHex32, type ProofStep, type TypedScalar} from "../src/index.js";
import {verifyProfileDisclosure, type ProfileDisclosure, type ProfileDisclosureEntry} from "../src/disclosure.js";

function salt(n: number): Uint8Array {
  return new Uint8Array(16).fill(n);
}
function saltHex(n: number): string {
  return "0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Attr {
  keyPath: string;
  saltByte: number;
  scalar: TypedScalar;
}

const ATTRS: Attr[] = [
  {keyPath: "credentialSubject.name", saltByte: 7, scalar: {tag: TypeTag.String, value: "Rex"}},
  {keyPath: "owner.identity.fullName", saltByte: 21, scalar: {tag: TypeTag.String, value: "Alice Owner"}},
  {keyPath: "owner.identity.country", saltByte: 22, scalar: {tag: TypeTag.String, value: "GB"}},
  {keyPath: "owner.identity.docNumber", saltByte: 23, scalar: {tag: TypeTag.String, value: "PASSPORT-123"}},
];

function buildTree() {
  const hashes = ATTRS.map((a) => hashLeaf(a.keyPath, salt(a.saltByte), a.scalar));
  const {root, layers} = buildMerkle(hashes);
  return {root, layers, hashes};
}

function stepsToWire(steps: ProofStep[]): string[] {
  return steps.map((s) => ("sibling" in s ? toHex32(s.sibling) : "promote"));
}

/** Build a disclosure for one attribute - mirrors what the device would produce. */
function discloseOne(attr: Attr, layers: ReturnType<typeof buildTree>["layers"], leafHash: bigint, root: bigint): ProfileDisclosure {
  const proof = merkleProof(layers, leafHash);
  const entry: ProfileDisclosureEntry = {
    keyPath: attr.keyPath,
    saltHex: saltHex(attr.saltByte),
    tag: attr.scalar.tag,
    value: attr.scalar.tag === TypeTag.Bytes ? "" : String((attr.scalar as {value: unknown}).value),
    proof: stepsToWire(proof),
  };
  return {dogTagId: toHex32(424242n), R: toHex32(root), disclosures: [entry]};
}

describe("verifyProfileDisclosure - accept", () => {
  it("a subset disclosure (one identity leaf) verifies against R", () => {
    const {root, layers, hashes} = buildTree();
    const idx = ATTRS.findIndex((a) => a.keyPath === "owner.identity.country");
    const d = discloseOne(ATTRS[idx]!, layers, hashes[idx]!, root);
    expect(verifyProfileDisclosure(d)).toBe(true);
  });

  it("a multi-leaf disclosure verifies every entry", () => {
    const {root, layers, hashes} = buildTree();
    const disclosures: ProfileDisclosureEntry[] = ATTRS.map((a, i) => {
      const proof = merkleProof(layers, hashes[i]!);
      return {
        keyPath: a.keyPath,
        saltHex: saltHex(a.saltByte),
        tag: a.scalar.tag,
        value: String((a.scalar as {value: unknown}).value),
        proof: stepsToWire(proof),
      };
    });
    const d: ProfileDisclosure = {dogTagId: toHex32(424242n), R: toHex32(root), disclosures};
    expect(verifyProfileDisclosure(d)).toBe(true);
  });

  it("a pet (non-identity) attribute discloses through the same envelope", () => {
    const {root, layers, hashes} = buildTree();
    const idx = ATTRS.findIndex((a) => a.keyPath === "credentialSubject.name");
    const d = discloseOne(ATTRS[idx]!, layers, hashes[idx]!, root);
    expect(verifyProfileDisclosure(d)).toBe(true);
  });

  it("round-trips through JSON with the frozen wire field names", () => {
    const {root, layers, hashes} = buildTree();
    const idx = ATTRS.findIndex((a) => a.keyPath === "owner.identity.fullName");
    const d = discloseOne(ATTRS[idx]!, layers, hashes[idx]!, root);
    const json = JSON.stringify(d);
    for (const key of ['"dogTagId"', '"R"', '"disclosures"', '"keyPath"', '"saltHex"']) {
      expect(json).toContain(key);
    }
    const back = JSON.parse(json) as ProfileDisclosure;
    expect(verifyProfileDisclosure(back)).toBe(true);
  });
});

describe("verifyProfileDisclosure - reject", () => {
  it("a tampered value fails to fold to R", () => {
    const {root, layers, hashes} = buildTree();
    const idx = ATTRS.findIndex((a) => a.keyPath === "owner.identity.country");
    const d = discloseOne(ATTRS[idx]!, layers, hashes[idx]!, root);
    d.disclosures[0]!.value = "US"; // forge the country
    expect(verifyProfileDisclosure(d)).toBe(false);
  });

  it("a foreign root fails", () => {
    const {root, layers, hashes} = buildTree();
    const idx = ATTRS.findIndex((a) => a.keyPath === "owner.identity.country");
    const d = discloseOne(ATTRS[idx]!, layers, hashes[idx]!, root);
    d.R = toHex32(1234n);
    expect(verifyProfileDisclosure(d)).toBe(false);
  });

  it("a tampered proof step fails", () => {
    const {root, layers, hashes} = buildTree();
    const idx = ATTRS.findIndex((a) => a.keyPath === "owner.identity.country");
    const d = discloseOne(ATTRS[idx]!, layers, hashes[idx]!, root);
    d.disclosures[0]!.proof = d.disclosures[0]!.proof.map((s) => (s === "promote" ? s : toHex32(999n)));
    expect(verifyProfileDisclosure(d)).toBe(false);
  });

  it.each(["owner.secret", "owner.address", "owner.consentKey", "owner.delegateKey"])(
    "an owner-control keyPath (%s) throws rather than reading as false",
    (kp) => {
      const {root, layers, hashes} = buildTree();
      const idx = ATTRS.findIndex((a) => a.keyPath === "owner.identity.country");
      const d = discloseOne(ATTRS[idx]!, layers, hashes[idx]!, root);
      d.disclosures[0]!.keyPath = kp;
      expect(() => verifyProfileDisclosure(d)).toThrow();
    },
  );

  it("an empty disclosures list throws (never reads as vacuously verified)", () => {
    const {root} = buildTree();
    const d: ProfileDisclosure = {dogTagId: toHex32(424242n), R: toHex32(root), disclosures: []};
    expect(() => verifyProfileDisclosure(d)).toThrow();
  });

  it("a duplicate disclosed keyPath throws", () => {
    const {root, layers, hashes} = buildTree();
    const idx = ATTRS.findIndex((a) => a.keyPath === "owner.identity.country");
    const d = discloseOne(ATTRS[idx]!, layers, hashes[idx]!, root);
    d.disclosures.push({...d.disclosures[0]!});
    expect(() => verifyProfileDisclosure(d)).toThrow();
  });

  it("a malformed salt hex throws rather than silently rejecting", () => {
    const {root, layers, hashes} = buildTree();
    const idx = ATTRS.findIndex((a) => a.keyPath === "owner.identity.country");
    const d = discloseOne(ATTRS[idx]!, layers, hashes[idx]!, root);
    d.disclosures[0]!.saltHex = "0xzz";
    expect(() => verifyProfileDisclosure(d)).toThrow();
  });
});
