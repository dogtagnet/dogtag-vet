// Unit coverage for recordArtifact.ts - WP4.14S. Unlike redactedArtifact.ts, there is no
// verifyLeafCommitment-shaped primitive a RecordArtifact generalizes (a record carries no owner
// identity leaves and no reserved triple for an equivalence proof to even be about), so this file is
// entirely hand-built fixtures - the masking-specific half of redacted_artifact.test.ts's own
// structure, extended with the two axes that make a RecordArtifact's policy genuinely different: the
// seven-keyPath non-maskable set (must be disclosed, never masked or missing) and the always-empty
// reservedLeafHashes rule (never 3, unlike a RedactedTagArtifact).
import {describe, it, expect} from "vitest";
import {TypeTag, hashLeaf, buildMerkle, toHex32, hexToBytes, fromHex32, type TypedScalar, type Field} from "../src/index.js";
import type {OpenedLeaf} from "../src/profileBind.js";
import {verifyRecordArtifact, RECORD_NON_MASKABLE_KEY_PATHS, type RecordArtifact} from "../src/recordArtifact.js";

function salt(n: number): Uint8Array {
  return new Uint8Array(16).fill(n);
}

function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function opened(keyPath: string, saltByte: number, tag: TypeTag, value: string): OpenedLeaf {
  return {keyPath, saltHex: bytesToHex(salt(saltByte)), tag, value};
}

function scalarOf(l: OpenedLeaf): TypedScalar {
  switch (l.tag) {
    case TypeTag.Null:
      return {tag: TypeTag.Null, value: null};
    case TypeTag.Bool:
      return {tag: TypeTag.Bool, value: l.value === "true"};
    case TypeTag.Bytes:
      return {tag: TypeTag.Bytes, value: hexToBytes(l.value)};
    default:
      return {tag: l.tag, value: l.value} as TypedScalar;
  }
}

function leafHashOf(l: OpenedLeaf): Field {
  return hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalarOf(l));
}

/** The seven non-maskable leaves a valid record artifact must disclose - realistic-looking values,
 * distinct salts per leaf. */
function nonMaskableOpenings(): OpenedLeaf[] {
  return [
    opened("credentialSubject.dogTagId", 1, TypeTag.String, "424242"),
    opened("recordType", 2, TypeTag.String, "VACCINATION"),
    opened("credentialSchema.id", 3, TypeTag.String, "https://dogtag.io/schemas/vaccination/v1"),
    opened("credentialSchema.version", 4, TypeTag.String, "1.0.0"),
    opened("issuer.chainId", 5, TypeTag.Integer, "135"),
    opened("issuer.contract", 6, TypeTag.String, "0x86d9ac6c094783e6a27d3bdbb6ef868060256c75"),
    opened("issuer.operator", 7, TypeTag.String, "0x15759c525000000000000000000000000000cda"),
  ];
}

function clinicalOpenings(): OpenedLeaf[] {
  return [
    opened("vaccineProductName", 8, TypeTag.String, "Rabvac 3"),
    opened("batchLotNumber", 9, TypeTag.String, "LOT-998"),
  ];
}

/** Build the real root from a set of openings (no reserved leaves for a record artifact ever). */
function computeRoot(leaves: OpenedLeaf[]): string {
  return toHex32(buildMerkle(leaves.map(leafHashOf)).root);
}

const ENVELOPE = {protocolVersion: "dogtag-v2/1", artifactType: "record" as const};

function artifact(root: string, disclosed: OpenedLeaf[], obfuscated: string[], reserved: string[]): RecordArtifact {
  return {...ENVELOPE, root, disclosed, obfuscatedLeafHashes: obfuscated, reservedLeafHashes: reserved};
}

describe("verifyRecordArtifact - accepts genuine artifacts", () => {
  it("accepts the full artifact (all 7 non-maskable + 2 clinical leaves disclosed, nothing masked)", () => {
    const leaves = [...nonMaskableOpenings(), ...clinicalOpenings()];
    const root = computeRoot(leaves);
    expect(verifyRecordArtifact(artifact(root, leaves, [], []))).toBe(true);
  });

  it("accepts a masked artifact with one clinical leaf obfuscated - root unchanged", () => {
    const [productName, batch] = clinicalOpenings();
    const full = [...nonMaskableOpenings(), productName, batch];
    const root = computeRoot(full);
    const masked = artifact(root, [...nonMaskableOpenings(), productName], [toHex32(leafHashOf(batch))], []);
    expect(verifyRecordArtifact(masked)).toBe(true);
  });

  it("accepts masking EVERY clinical leaf, disclosing only the seven non-maskable ones - the falsifiable non-maskable-set-is-real finding", () => {
    const [productName, batch] = clinicalOpenings();
    const full = [...nonMaskableOpenings(), productName, batch];
    const root = computeRoot(full);
    const masked = artifact(root, nonMaskableOpenings(), [productName, batch].map((l) => toHex32(leafHashOf(l))), []);
    expect(verifyRecordArtifact(masked)).toBe(true);
  });

  it("accepts a record with only the seven non-maskable leaves and no clinical leaves at all", () => {
    const leaves = nonMaskableOpenings();
    const root = computeRoot(leaves);
    expect(verifyRecordArtifact(artifact(root, leaves, [], []))).toBe(true);
  });
});

describe("verifyRecordArtifact - rejects a non-maskable leaf that is masked or missing", () => {
  for (const missingKeyPath of RECORD_NON_MASKABLE_KEY_PATHS) {
    it(`rejects when ${missingKeyPath} is moved to obfuscatedLeafHashes instead of disclosed (root unchanged)`, () => {
      const nonMaskable = nonMaskableOpenings();
      const [productName] = clinicalOpenings();
      const full = [...nonMaskable, productName];
      const root = computeRoot(full);
      const missing = nonMaskable.find((l) => l.keyPath === missingKeyPath)!;
      const disclosed = full.filter((l) => l.keyPath !== missingKeyPath);
      const a = artifact(root, disclosed, [toHex32(leafHashOf(missing))], []);
      expect(verifyRecordArtifact(a)).toBe(false);
    });

    it(`rejects when ${missingKeyPath} is entirely absent (not disclosed, not obfuscated)`, () => {
      const nonMaskable = nonMaskableOpenings();
      const [productName] = clinicalOpenings();
      const disclosed = [...nonMaskable.filter((l) => l.keyPath !== missingKeyPath), productName];
      // A genuine root the SHORTENED disclosed set folds to on its own (not the full 8-leaf root) -
      // isolates the presence check rather than accidentally also failing the root comparison.
      const root = computeRoot(disclosed);
      const a = artifact(root, disclosed, [], []);
      expect(verifyRecordArtifact(a)).toBe(false);
    });
  }
});

describe("verifyRecordArtifact - reservedLeafHashes must always be empty", () => {
  it("rejects a single (bogus) reserved hash even when genuinely folded into the posted root", () => {
    const leaves = [...nonMaskableOpenings(), ...clinicalOpenings()];
    const bogus = fromHex32("0x" + "0".repeat(63) + "1");
    const root = toHex32(buildMerkle([bogus, ...leaves.map(leafHashOf)]).root);
    const a = artifact(root, leaves, [], [toHex32(bogus)]);
    expect(verifyRecordArtifact(a)).toBe(false);
  });

  it("rejects three reserved hashes too (the RedactedTagArtifact-shaped count is not special-cased as acceptable here)", () => {
    const leaves = [...nonMaskableOpenings(), ...clinicalOpenings()];
    const reserved = [salt(201), salt(202), salt(203)].map((s, i) =>
      toHex32(hashLeaf(`owner.fake${i}`, s, {tag: TypeTag.Bytes, value: new Uint8Array([i + 1])} as TypedScalar)),
    );
    const reservedFields = reserved.map(fromHex32);
    const root = toHex32(buildMerkle([...reservedFields, ...leaves.map(leafHashOf)]).root);
    const a = artifact(root, leaves, [], reserved);
    expect(verifyRecordArtifact(a)).toBe(false);
  });
});

describe("verifyRecordArtifact - the 64-leaf cap does not apply (section 10 is a consent-bind-only policy)", () => {
  it("accepts a record with far more than 64 total leaves", () => {
    const many: OpenedLeaf[] = Array.from({length: 80}, (_, i) => opened(`credentialSubject.extra[${i}]`, (i % 250) + 20, TypeTag.String, `v${i}`));
    const leaves = [...nonMaskableOpenings(), ...many];
    const root = computeRoot(leaves);
    expect(verifyRecordArtifact(artifact(root, leaves, [], []))).toBe(true);
  });
});

describe("verifyRecordArtifact - overlap, duplicate, owner-namespace, and malformed-input rejections", () => {
  it("rejects a genuinely duplicated clinical leaf hash - one copy disclosed, the other copy's hash obfuscated", () => {
    const [productName] = clinicalOpenings();
    const hash = leafHashOf(productName);
    const root = toHex32(buildMerkle([...nonMaskableOpenings().map(leafHashOf), hash, hash]).root);
    const a = artifact(root, [...nonMaskableOpenings(), productName], [toHex32(hash)], []);
    expect(verifyRecordArtifact(a)).toBe(false);
  });

  it("rejects a duplicate disclosed keyPath (different salts, both genuinely fold into the root)", () => {
    const a1 = opened("vaccineProductName", 10, TypeTag.String, "Rabvac 3");
    const a2 = opened("vaccineProductName", 20, TypeTag.String, "Rabvac 3");
    const leaves = [...nonMaskableOpenings(), a1, a2];
    const root = computeRoot(leaves);
    expect(verifyRecordArtifact(artifact(root, leaves, [], []))).toBe(false);
  });

  it("rejects a disclosed leaf naming a reserved owner-control keyPath", () => {
    const sneaky = opened("owner.secret", 99, TypeTag.String, "x");
    const leaves = [...nonMaskableOpenings(), sneaky];
    const root = computeRoot(leaves);
    expect(verifyRecordArtifact(artifact(root, leaves, [], []))).toBe(false);
  });

  it("rejects a wrong root", () => {
    const leaves = [...nonMaskableOpenings(), ...clinicalOpenings()];
    expect(verifyRecordArtifact(artifact(toHex32(BigInt(999_999)), leaves, [], []))).toBe(false);
  });

  it("fails closed on a too-short salt (\"0xzz\" decodes to ONE byte, caught by hashLeaf's salt.length !== 16 guard - NOT a hex-validity check; see the dedicated non-hex-at-16-bytes test below for that axis, fix round 1 D2)", () => {
    const bad: OpenedLeaf = {keyPath: "credentialSubject.dogTagId", saltHex: "0xzz", tag: TypeTag.String, value: "424242"};
    const leaves = [bad, ...nonMaskableOpenings().slice(1)];
    expect(verifyRecordArtifact(artifact("0x" + "ab".repeat(32), leaves, [], []))).toBe(false);
  });

  // Fix round 1 D2 (grade wp4.14S-grade.md): the test above rejects "0xzz" for the WRONG reason to
  // pin the actual divergence - it decodes to one byte, caught by hashLeaf's byte-length guard, never
  // by a hex-validity check. This is the grader's minimal reproduction: a non-hex saltHex AT THE
  // CORRECT 16-byte length, on one of the seven non-maskable leaves, root computed over the resulting
  // (frozen-hexToBytes) zero-filled salt. Before this fix round, TS accepted this (silently zero-filled
  // via hexToBytes's NaN-coerces-to-0 leniency) while Rust's hex::decode rejected it outright - an
  // undisclosed, unpinned divergence a fuzz run found 371/4000 cases of. Now both reject.
  it("rejects a non-hex saltHex AT THE CORRECT 16-byte length on a non-maskable leaf (fix round 1 D2 - the grader's minimal reproduction)", () => {
    const malformedSalt = "0x" + "z".repeat(32); // 32 hex-shaped chars = 16 bytes if it were valid hex
    const malformed: OpenedLeaf = {keyPath: "credentialSubject.dogTagId", saltHex: malformedSalt, tag: TypeTag.String, value: "424242"};
    const leaves = [malformed, ...nonMaskableOpenings().slice(1), ...clinicalOpenings()];
    // Root-preserving: computeRoot uses the SAME leafHashOf -> hashLeaf(keyPath, hexToBytes(saltHex),
    // scalar) pipeline recomputeLeaf uses, so this root is genuinely the root of THIS exact (zero-salt
    // via hexToBytes's leniency) leaf set - isolating the new guard rather than a root mismatch.
    const root = computeRoot(leaves);
    expect(verifyRecordArtifact(artifact(root, leaves, [], []))).toBe(false);
  });

  it("fix round 1 D2: a genuinely well-formed 16-byte saltHex (hex, even length) still verifies normally - the new guard only rejects, never additionally accepts or changes a correct root", () => {
    const leaves = [...nonMaskableOpenings(), ...clinicalOpenings()];
    const root = computeRoot(leaves);
    expect(verifyRecordArtifact(artifact(root, leaves, [], []))).toBe(true);
  });

  it("fix round 1 D2: accepts a saltHex without the 0x prefix (the shape specs/leaf-commitment-vectors.json's own recordArtifactVectors entries actually use) - the guard does not require the prefix, only hex digits at even length", () => {
    const noPrefixLeaf = opened("vaccineProductName", 30, TypeTag.String, "Rabvac 3");
    const withPrefixSalt = noPrefixLeaf.saltHex;
    expect(withPrefixSalt.startsWith("0x")).toBe(true);
    const stripped: OpenedLeaf = {...noPrefixLeaf, saltHex: withPrefixSalt.slice(2)};
    const leaves = [...nonMaskableOpenings(), stripped];
    const root = computeRoot(leaves);
    expect(verifyRecordArtifact(artifact(root, leaves, [], []))).toBe(true);
  });

  it("fails closed on a hostile unknown type tag", () => {
    const hostile: OpenedLeaf = {keyPath: "credentialSubject.dogTagId", saltHex: bytesToHex(salt(1)), tag: 99 as TypeTag, value: "424242"};
    const leaves = [hostile, ...nonMaskableOpenings().slice(1)];
    expect(verifyRecordArtifact(artifact("0x" + "ab".repeat(32), leaves, [], []))).toBe(false);
  });

  it("rejects malformed hex shape (obfuscatedLeafHashes, reservedLeafHashes, root) fail-closed", () => {
    const leaves = [...nonMaskableOpenings(), ...clinicalOpenings()];
    const root = computeRoot(leaves);
    expect(verifyRecordArtifact(artifact(root, leaves, ["0xnothex"], []))).toBe(false);
    expect(verifyRecordArtifact(artifact(root, leaves, [], ["not-a-hash"]))).toBe(false);
    expect(verifyRecordArtifact(artifact("0xshort", leaves, [], []))).toBe(false);
  });

  // Fix round 1 D4 (grade wp4.14S-grade.md): the test above does NOT isolate the
  // `obfuscatedLeafHashes.every(isHex32)` guard - with it deleted, "0xnothex" still throws inside
  // fromHex32 and "not-a-hash"/"0xshort" are still caught elsewhere, so the same `false` comes out by a
  // DIFFERENT path and the guard itself is mutation-survivable. This test uses the grader's corrected
  // isolating input: a 64-hex-character string with NO `0x` prefix, below the BN254 modulus
  // ("0a".repeat(32)) - fromHex32 accepts this (BigInt("0x"+s)) once the isHex32 guard (which REQUIRES
  // the 0x prefix) is gone, so deleting the guard makes a non-canonical, prefix-less hash verify
  // successfully: two spellings of the same hash both accepted, a wire-format ambiguity, not merely a
  // redundancy. (The tempting "0x1" does NOT isolate this in Rust - `from_hex32` still rejects it via
  // `hex::decode("1")`'s odd-digit-count error - so it is deliberately NOT used here either, keeping
  // the TS and Rust fixtures identical.) Root-preserving: `root` genuinely folds over this exact
  // prefix-less string via `fromHex32`, so this artifact is rejected ONLY by the isHex32 guard, never
  // by a root mismatch.
  it("rejects a prefix-less 64-hex obfuscatedLeafHashes entry (isolates the isHex32 guard - fix round 1 D4)", () => {
    const leaves = [...nonMaskableOpenings(), ...clinicalOpenings()];
    const prefixLess = "0a".repeat(32);
    const prefixLessField = fromHex32(prefixLess);
    const root = toHex32(buildMerkle([prefixLessField, ...leaves.map(leafHashOf)]).root);
    const a = artifact(root, leaves, [prefixLess], []);
    expect(verifyRecordArtifact(a)).toBe(false);
  });
});

describe("verifyRecordArtifact - never panics/throws on an all-empty artifact (the build_merkle empty-slice bite proof)", () => {
  it("rejects disclosed=[], obfuscatedLeafHashes=[], reservedLeafHashes=[] without throwing", () => {
    expect(() => verifyRecordArtifact(artifact("0x" + "00".repeat(32), [], [], []))).not.toThrow();
    expect(verifyRecordArtifact(artifact("0x" + "00".repeat(32), [], [], []))).toBe(false);
  });
});

// Advisor round 2 item 4: unlike RedactedTagArtifact's own schemaId field (no committed leaf
// counterpart to diverge from at all), a RecordArtifact's schemaId DOES have one - credentialSchema.id
// is always a non-maskable disclosed leaf here - so it is cross-checked when present.
describe("verifyRecordArtifact - the optional schemaId, when present, must agree with the disclosed credentialSchema.id leaf", () => {
  it("accepts a schemaId that matches the disclosed credentialSchema.id leaf", () => {
    const leaves = [...nonMaskableOpenings(), ...clinicalOpenings()];
    const root = computeRoot(leaves);
    const a: RecordArtifact = {...artifact(root, leaves, [], []), schemaId: "https://dogtag.io/schemas/vaccination/v1"};
    expect(verifyRecordArtifact(a)).toBe(true);
  });

  it("rejects a schemaId that disagrees with the disclosed credentialSchema.id leaf, even though the root itself is genuine", () => {
    const leaves = [...nonMaskableOpenings(), ...clinicalOpenings()];
    const root = computeRoot(leaves);
    const a: RecordArtifact = {...artifact(root, leaves, [], []), schemaId: "https://dogtag.io/schemas/rabies-vaccination/v1"};
    expect(verifyRecordArtifact(a)).toBe(false);
  });

  it("accepts schemaId absent entirely - the cross-check is only forced when the field is present", () => {
    const leaves = [...nonMaskableOpenings(), ...clinicalOpenings()];
    const root = computeRoot(leaves);
    const a = artifact(root, leaves, [], []);
    expect((a as RecordArtifact).schemaId).toBeUndefined();
    expect(verifyRecordArtifact(a)).toBe(true);
  });
});
