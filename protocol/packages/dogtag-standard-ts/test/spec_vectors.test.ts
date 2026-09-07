// Conformance gate for specs/leaf-commitment.md (S1): loads specs/leaf-commitment-vectors.json and
// asserts this package's implementation reproduces every vector exactly - the same "recompute from
// the vector's own inputs, compare against its own recorded output" discipline as parity.test.ts,
// applied to the spec's own curated, human-readable vector set rather than the larger internal
// cross-language fixture file. Per the spec's conformance clause (section 13): an implementation is
// conformant iff it reproduces every vector here, including the negative (invalid) ones.
import {describe, it, expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {TypeTag, type TypedScalar} from "../src/types.js";
import {hashLeaf} from "../src/leaf.js";
import {buildMerkle, hashNode, verifyInclusion, type ProofStep} from "../src/merkle.js";
import {toHex32, fromHex32, type Field} from "../src/field.js";
import {hexToBytes} from "../src/encode.js";
import {dogTagIdField, type OpenedLeaf} from "../src/profileBind.js";
import {verifyRedactedArtifact, type RedactedTagArtifact} from "../src/redactedArtifact.js";
import {verifyRecordArtifact, type RecordArtifact} from "../src/recordArtifact.js";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const VECTORS_PATH = resolve(REPO_ROOT, "specs", "leaf-commitment-vectors.json");
const SPEC_PATH = resolve(REPO_ROOT, "specs", "leaf-commitment.md");

interface LeafHashVector {
  name: string;
  keyPath: string;
  saltHex: string;
  tag: TypeTag;
  tagName: string;
  value: unknown;
  expected_dec: string;
  expected_hex: string;
  notes: string;
}

interface MerkleLeafOpening {
  keyPath: string;
  saltHex: string;
  tag: TypeTag;
  tagName: string;
  value: string;
  expected_leaf_hex: string;
}

interface MerkleVector {
  name: string;
  notes: string;
  leaves: MerkleLeafOpening[];
  promoted_leaf_hex: string;
  promoted_leaf_keyPath: string;
  root_hex: string;
  /** Present on multi-level trees (5+ leaves): buildMerkle's own layer-by-layer output, level 0 =
   * the sorted leaf hashes, last entry = [root_hex]. Absent on the original 3-leaf vector (one fold
   * round only, so `promoted_leaf_hex`/`promoted_leaf_keyPath` already say everything there is to say). */
  levels?: string[][];
}

type WireStep = {sibling: string} | {promote: true};

interface InclusionVector {
  name: string;
  references: string;
  keyPath: string;
  saltHex: string;
  tag: TypeTag;
  tagName: string;
  value: string;
  steps: WireStep[];
  root_hex: string;
  valid: boolean;
  notes: string;
}

interface DogTagIdFieldVector {
  handleDec: string;
  expected_dec: string;
  expected_hex: string;
}

interface RedactedArtifactWireLeaf {
  keyPath: string;
  saltHex: string;
  tag: TypeTag;
  tagName: string;
  value: string;
  expected_leaf_hex: string;
}

interface RedactedArtifactVector {
  name: string;
  notes: string;
  disclosed: RedactedArtifactWireLeaf[];
  obfuscatedLeafHashes: string[];
  reservedLeafHashes: string[];
  root_hex: string;
  valid: boolean;
}

// WP4.14S - identical wire shape to RedactedArtifactWireLeaf/RedactedArtifactVector above, named
// separately because it describes a different section (recordArtifactVectors, section 16) whose
// reservedLeafHashes is always empty rather than always 3 (the "file shape guard" describe block
// below checks only presence/non-emptiness of the section itself, not that per-entry difference -
// see test/recordArtifact.test.ts for the semantic check against the real verifyRecordArtifact).
interface RecordArtifactWireLeaf {
  keyPath: string;
  saltHex: string;
  tag: TypeTag;
  tagName: string;
  value: string;
  expected_leaf_hex: string;
}

interface RecordArtifactVector {
  name: string;
  notes: string;
  disclosed: RecordArtifactWireLeaf[];
  obfuscatedLeafHashes: string[];
  reservedLeafHashes: string[];
  root_hex: string;
  valid: boolean;
}

interface VectorsFile {
  _comment: string;
  field_p: string;
  leafHashVectors: LeafHashVector[];
  merkleVectors: MerkleVector[];
  inclusionVectors: InclusionVector[];
  dogTagIdFieldVectors: DogTagIdFieldVector[];
  redactedArtifactVectors: RedactedArtifactVector[];
  recordArtifactVectors: RecordArtifactVector[];
}

const FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const file = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as VectorsFile;
const specText = readFileSync(SPEC_PATH, "utf8");
const vectorsRawText = readFileSync(VECTORS_PATH, "utf8");
// The spec also cites exactly one value from the older, separate cross-language fixture file
// (section 5's bytesToField("") illustration, explicitly attributed to testvectors.json in prose) -
// a legitimate second source, not drift, so the cross-check below must recognize both files.
const OLD_TESTVECTORS_PATH = resolve(REPO_ROOT, "packages", "dogtag-standard-ts", "testvectors.json");
const oldTestvectorsRawText = readFileSync(OLD_TESTVECTORS_PATH, "utf8");

// Parsed (not just raw-text) view of testvectors.json's redactedArtifacts, used only by the
// "promoted from testvectors.json" drift guard below (WP4.10S P1) - the hex-drift guard above stays
// a raw substring check, this one needs actual field access to compare vector-to-vector.
interface OldRedactedArtifactWireLeaf {
  keyPath: string;
  saltHex: string;
  tag: TypeTag;
  value: string;
}
interface OldRedactedArtifactVector {
  name: string;
  disclosed: OldRedactedArtifactWireLeaf[];
  obfuscatedLeafHashes: string[];
  reservedLeafHashes: string[];
  root: string;
  valid: boolean;
}
const oldFile = JSON.parse(oldTestvectorsRawText) as {redactedArtifacts: OldRedactedArtifactVector[]};

/**
 * Reconstruct the exact TypedScalar a leafHashVectors/merkleVectors/inclusionVectors entry's
 * `value` field encodes, per the vectors file's own `_comment`: every tag's JSON value IS the
 * literal to feed into `{tag, value}`, except Bytes, whose JSON value is lowercase hex decoded
 * via hexToBytes.
 */
function scalarFromVectorValue(tag: TypeTag, value: unknown): TypedScalar {
  if (tag === TypeTag.Bytes) {
    return {tag, value: hexToBytes(value as string)} as TypedScalar;
  }
  return {tag, value} as TypedScalar;
}

function stepsFromWire(steps: WireStep[]): ProofStep[] {
  return steps.map((s) => ("sibling" in s ? {sibling: fromHex32(s.sibling)} : {promote: true}));
}

describe("specs/leaf-commitment-vectors.json - file shape guard", () => {
  it("the field modulus matches the SDK's FIELD_P", () => {
    expect(BigInt(file.field_p)).toBe(FIELD_P);
  });

  it("every vector category is present and non-empty", () => {
    for (const key of [
      "leafHashVectors",
      "merkleVectors",
      "inclusionVectors",
      "dogTagIdFieldVectors",
      "redactedArtifactVectors",
      "recordArtifactVectors",
    ] as const) {
      expect(Array.isArray(file[key]), `${key} must be an array`).toBe(true);
      expect(file[key].length, `${key} must be non-empty`).toBeGreaterThan(0);
    }
  });

  it("no top-level key is unrecognized (guards a silently renamed/dropped section)", () => {
    const known = new Set([
      "_comment",
      "field_p",
      "leafHashVectors",
      "merkleVectors",
      "inclusionVectors",
      "dogTagIdFieldVectors",
      "redactedArtifactVectors",
      "recordArtifactVectors",
    ]);
    for (const key of Object.keys(file)) {
      expect(known.has(key), `unrecognized leaf-commitment-vectors.json key: ${key}`).toBe(true);
    }
  });

  it("leafHashVectors represents every TypeTag (0 through 5)", () => {
    const tags = new Set(file.leafHashVectors.map((v) => v.tag));
    for (const t of [TypeTag.Null, TypeTag.Bool, TypeTag.String, TypeTag.Integer, TypeTag.Decimal, TypeTag.Bytes]) {
      expect(tags.has(t), `no leafHashVectors entry uses TypeTag ${TypeTag[t]} (${t})`).toBe(true);
    }
  });

  it("leafHashVectors includes at least one NFC-normalization pair", () => {
    const names = new Set(file.leafHashVectors.map((v) => v.name));
    expect(names.has("string_nfc_leaf")).toBe(true);
    expect(names.has("nfc_alias_leaf")).toBe(true);
  });

  it("merkleVectors contains at least one tree with 5 or more leaves (pins section 7's per-level no-re-sort rule)", () => {
    // Below 5 leaves, "re-sort every level" and "never re-sort above the leaf level" agree on every
    // tree, so a vector set with only smaller trees cannot falsify either reading of section 7 - this
    // is the exact gap that let the pre-fix spec text ship undetected.
    expect(file.merkleVectors.some((v) => v.leaves.length >= 5)).toBe(true);
  });

  it("inclusionVectors contains at least one entry whose steps include a {promote: true} step", () => {
    // Section 8 defines two normative step shapes; without this, a third-language implementation
    // could omit or mis-implement the {promote} branch entirely and still pass every vector here.
    expect(file.inclusionVectors.some((v) => v.steps.some((s) => "promote" in s))).toBe(true);
  });

  it("inclusionVectors contains at least one entry with 3 or more steps (pins section 8's one-step-per-tree-level rule on a tree taller than 2 levels)", () => {
    // Every vector before N3 sat on the 3-leaf tree, so every proof was exactly 2 steps long - an
    // implementation that mishandles depth (wrong step count on a taller tree) would still pass.
    expect(file.inclusionVectors.some((v) => v.steps.length >= 3)).toBe(true);
  });

  it("inclusionVectors contains at least one entry with two CONSECUTIVE {promote: true} steps", () => {
    // Distinct from the single-{promote} guard above: a node can be promoted at two levels in a row
    // (e.g. it is the odd-one-out at both level 0 and level 1), and an implementation that only
    // handles an isolated promote correctly could still mis-fold this shape.
    const hasConsecutivePromotes = (steps: WireStep[]): boolean =>
      steps.some((s, i) => i + 1 < steps.length && "promote" in s && "promote" in steps[i + 1]!);
    expect(file.inclusionVectors.some((v) => hasConsecutivePromotes(v.steps))).toBe(true);
  });
});

describe("leafHashVectors - hashLeaf reproduces every recorded hash", () => {
  for (const v of file.leafHashVectors) {
    it(`${v.name}: hashLeaf("${v.keyPath}", ...) matches expected_hex and expected_dec`, () => {
      const scalar = scalarFromVectorValue(v.tag, v.value);
      const h: Field = hashLeaf(v.keyPath, hexToBytes(v.saltHex), scalar);
      expect(toHex32(h)).toBe(v.expected_hex.toLowerCase());
      expect(h.toString()).toBe(v.expected_dec);
    });
  }

  it("string_nfc_leaf and nfc_alias_leaf hash identically (NFC pinning)", () => {
    const a = file.leafHashVectors.find((v) => v.name === "string_nfc_leaf")!;
    const b = file.leafHashVectors.find((v) => v.name === "nfc_alias_leaf")!;
    expect(a.expected_hex).toBe(b.expected_hex);
    // and the two JSON string literals must actually be byte-distinct, or this vector proves nothing
    expect(a.value).not.toBe(b.value);
  });

  it("decimal_leaf and decimal_leaf_canonical_form_check hash identically (decimal canonicalization)", () => {
    const a = file.leafHashVectors.find((v) => v.name === "decimal_leaf")!;
    const b = file.leafHashVectors.find((v) => v.name === "decimal_leaf_canonical_form_check")!;
    expect(a.expected_hex).toBe(b.expected_hex);
    expect(a.value).not.toBe(b.value);
  });
});

describe("merkleVectors - buildMerkle reproduces every leaf hash and the root", () => {
  for (const tv of file.merkleVectors) {
    describe(tv.name, () => {
      const recomputedLeafHashes = tv.leaves.map((l) =>
        hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalarFromVectorValue(l.tag, l.value)),
      );

      it("every opening's leaf hash matches expected_leaf_hex", () => {
        tv.leaves.forEach((l, i) => {
          expect(toHex32(recomputedLeafHashes[i]!)).toBe(l.expected_leaf_hex.toLowerCase());
        });
      });

      it("buildMerkle over the recomputed leaf hashes matches root_hex", () => {
        const {root} = buildMerkle(recomputedLeafHashes);
        expect(toHex32(root)).toBe(tv.root_hex.toLowerCase());
      });

      it("the recorded promoted leaf is the numerically-largest leaf hash (odd-count promotion)", () => {
        // NOTE: `promoted_leaf_hex`/`promoted_leaf_keyPath` describe only the LEAF-LEVEL promotion
        // (the fold's first round). A tree can promote more than once as it climbs (size_5_multi_level_fold
        // promotes credentialSubject.name twice - see its own `notes` and the `levels` check below);
        // this assertion is about level 0 specifically, which is why it holds for every vector in this
        // file regardless of how many total promotions that vector's tree goes through.
        const sorted = [...recomputedLeafHashes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const largest = sorted[sorted.length - 1]!;
        expect(toHex32(largest)).toBe(tv.promoted_leaf_hex.toLowerCase());
        const idx = tv.leaves.findIndex((l) => l.expected_leaf_hex.toLowerCase() === tv.promoted_leaf_hex.toLowerCase());
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(tv.leaves[idx]!.keyPath).toBe(tv.promoted_leaf_keyPath);
      });

      if (tv.levels) {
        it("every intermediate fold level matches `levels` exactly, in order, unsorted above the leaf level", () => {
          // This is the CONFORMANCE-ARTIFACT check for section 7's no-re-sort rule: it compares the
          // real buildMerkle's own layer-by-layer output against the vector file's pinned `levels`,
          // level by level, not just the final root. It does not (and cannot) check whether the SPEC
          // PROSE says the right thing - a hand-typed vector could agree with a wrong reading of section
          // 7 too, which is exactly the class of bug D2 found in this file's own worked example. The
          // independent proof that the prose itself is correct is the "section 7 property test" describe
          // block below, which transcribes the prose from scratch and compares it against this same
          // buildMerkle, never against this vector.
          const {layers} = buildMerkle(recomputedLeafHashes);
          const actual = layers.map((level) => level.map((h) => toHex32(h)));
          const expected = tv.levels!.map((level) => level.map((h) => h.toLowerCase()));
          expect(actual).toEqual(expected);
        });
      }
    });
  }
});

describe("inclusionVectors - verifyInclusion matches every recorded outcome", () => {
  for (const v of file.inclusionVectors) {
    it(`${v.name}: verifyInclusion returns ${v.valid}`, () => {
      const scalar = scalarFromVectorValue(v.tag, v.value);
      const steps = stepsFromWire(v.steps);
      const root = fromHex32(v.root_hex);
      expect(verifyInclusion(v.keyPath, hexToBytes(v.saltHex), scalar, steps, root)).toBe(v.valid);
    });
  }

  it("carries at least one valid and one deliberately-invalid vector", () => {
    const outcomes = new Set(file.inclusionVectors.map((v) => v.valid));
    expect(outcomes.has(true)).toBe(true);
    expect(outcomes.has(false)).toBe(true);
  });
});

describe("D1 fix - section 7's CORRECTED buildMerkle algorithm, independently transcribed from the spec's prose, matches the implementation", () => {
  // This is the D1 proof obligation: an independent, from-scratch transcription of
  // specs/leaf-commitment.md section 7 AS CORRECTED (sort the leaf hashes ascending ONCE, then
  // repeatedly pair the current level's list consecutively and promote an unpaired last element
  // unchanged, WITHOUT re-sorting any level above the leaf level), compared against the real
  // buildMerkle for random leaf sets. This function never imports or calls buildMerkle, so agreement
  // is a genuine test that the spec's prose and the implementation describe the same algorithm - not
  // a tautology. Unlike the `levels`-based check above (which only pins THIS FILE's specific vectors),
  // this is the check that actually reads as "does the corrected section 7 text match the code."
  const bigIntCmp = (a: Field, b: Field): number => (a < b ? -1 : a > b ? 1 : 0);

  function specSection7Root(leafHashes: Field[]): Field {
    if (leafHashes.length === 0) throw new Error("empty leaf set");
    let level = [...leafHashes].sort(bigIntCmp); // step 1: sort ascending, ONCE
    while (level.length > 1) {
      const next: Field[] = [];
      for (let i = 0; i < level.length; ) {
        if (i + 1 < level.length) {
          next.push(hashNode(level[i]!, level[i + 1]!)); // steps 2/3: pair consecutively
          i += 2;
        } else {
          next.push(level[i]!); // step 2: promote the unpaired last element unchanged
          i += 1;
        }
      }
      level = next; // step 4: repeat on the new level WITHOUT re-sorting it
    }
    return level[0]!;
  }

  // The PRE-FIX spec text's algorithm (re-sort every level before folding). Kept ONLY to prove the
  // fix was necessary (below) - never treated as correct, and its output is never written to the
  // public vectors file, only asserted here as a fixed, known-wrong value.
  function preFixResortEveryLevelRoot(leafHashes: Field[]): Field {
    let level = [...leafHashes].sort(bigIntCmp);
    while (level.length > 1) {
      level = [...level].sort(bigIntCmp); // the bug: re-sorting a level the fold already produced
      const next: Field[] = [];
      for (let i = 0; i < level.length; ) {
        if (i + 1 < level.length) {
          next.push(hashNode(level[i]!, level[i + 1]!));
          i += 2;
        } else {
          next.push(level[i]!);
          i += 1;
        }
      }
      level = next;
    }
    return level[0]!;
  }

  // Deterministic PRNG (mulberry32): this property's truth does not depend on which random values are
  // chosen (the two fold implementations either agree structurally for every input, or they do not),
  // so a fixed seed per tree size buys perfectly reproducible trial counts and failure messages without
  // weakening the test.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomField(rng: () => number): Field {
    // 31 random bytes (< 2^248 < FIELD_P) is always a valid field element, and collisions between two
    // independently-drawn 248-bit values are astronomically unlikely - no need for the full 32-byte range.
    let hex = "0x";
    for (let i = 0; i < 31; i++) hex += Math.floor(rng() * 256).toString(16).padStart(2, "0");
    return BigInt(hex);
  }

  const TRIALS_PER_SIZE = 50;
  const MAX_LEAVES = 16;

  for (let n = 1; n <= MAX_LEAVES; n++) {
    it(`n=${n}: the corrected section-7 transcription agrees with buildMerkle on ${TRIALS_PER_SIZE} random leaf sets`, () => {
      const rng = mulberry32(0x9e3779b9 ^ n);
      for (let trial = 0; trial < TRIALS_PER_SIZE; trial++) {
        const leaves = Array.from({length: n}, () => randomField(rng));
        const implRoot = buildMerkle(leaves).root;
        const specRoot = specSection7Root(leaves);
        expect(
          toHex32(specRoot),
          `n=${n} trial=${trial}: corrected section-7 transcription disagrees with buildMerkle`,
        ).toBe(toHex32(implRoot));
      }
    });
  }

  it(`ran ${MAX_LEAVES} leaf-set sizes x ${TRIALS_PER_SIZE} trials = ${MAX_LEAVES * TRIALS_PER_SIZE} agreements total (pins the trial count so a future edit cannot silently shrink this property test)`, () => {
    expect(MAX_LEAVES * TRIALS_PER_SIZE).toBe(800);
  });

  it("proves the fix was necessary: the PRE-FIX (re-sort every level) reading diverges from the implementation on merkleVectors[1]'s 5-leaf tree", () => {
    const tv = file.merkleVectors.find((v) => v.name === "size_5_multi_level_fold")!;
    const leafHashes = tv.leaves.map((l) =>
      hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalarFromVectorValue(l.tag, l.value)),
    );
    const implRoot = buildMerkle(leafHashes).root;
    const preFixRoot = preFixResortEveryLevelRoot(leafHashes);
    expect(toHex32(implRoot)).toBe(tv.root_hex.toLowerCase());
    // This exact value is the pre-fix algorithm's WRONG root for this specific tree - pinned here only
    // to make the divergence deterministic (no search-until-found at test time). Deliberately never
    // written to the public vectors file, which must only ever carry CORRECT values.
    expect(toHex32(preFixRoot)).toBe("0x186aef86a0e6a45d6a5c3a020d44766bd6293a2f3ae64c2854d0bf140fd4613a");
    expect(toHex32(preFixRoot)).not.toBe(toHex32(implRoot));
  });
});

describe("dogTagIdFieldVectors - dogTagIdField reproduces every recorded field element", () => {
  for (const v of file.dogTagIdFieldVectors) {
    it(`dogTagIdField("${v.handleDec}") matches expected_dec and expected_hex`, () => {
      const f = dogTagIdField(v.handleDec);
      expect(f.toString()).toBe(v.expected_dec);
      expect(toHex32(f)).toBe(v.expected_hex.toLowerCase());
    });
  }
});

describe("redactedArtifactVectors - verifyRedactedArtifact reproduces every recorded outcome (section 15)", () => {
  function toOpened(l: RedactedArtifactWireLeaf): OpenedLeaf {
    return {keyPath: l.keyPath, saltHex: l.saltHex, tag: l.tag, value: l.value};
  }

  it("carries at least 2 masked-but-valid variants and at least 2 deliberately-invalid negatives", () => {
    const valid = file.redactedArtifactVectors.filter((v) => v.valid);
    const invalid = file.redactedArtifactVectors.filter((v) => !v.valid);
    // The FIRST valid entry is the unmasked base (nothing obfuscated) - not itself a "masked
    // variant" - so this counts only entries that actually obfuscate at least one leaf.
    const maskedVariants = valid.filter((v) => v.obfuscatedLeafHashes.length > 0);
    expect(maskedVariants.length, "masked (obfuscatedLeafHashes non-empty) but still-valid vectors").toBeGreaterThanOrEqual(2);
    expect(invalid.length).toBeGreaterThanOrEqual(2);
  });

  for (const v of file.redactedArtifactVectors) {
    it(`${v.name}: verifyRedactedArtifact returns ${v.valid}`, () => {
      const artifact: RedactedTagArtifact = {
        protocolVersion: "dogtag-v2/1",
        dogTagIdField: "1",
        issuerClone: "0x" + "11".repeat(20),
        root: v.root_hex,
        disclosed: v.disclosed.map(toOpened),
        obfuscatedLeafHashes: v.obfuscatedLeafHashes,
        reservedLeafHashes: v.reservedLeafHashes,
      };
      expect(verifyRedactedArtifact(artifact)).toBe(v.valid);
    });
  }

  it("every disclosed leaf's expected_leaf_hex matches hashLeaf, independent of verifyRedactedArtifact itself", () => {
    for (const v of file.redactedArtifactVectors) {
      for (const l of v.disclosed) {
        const scalar = scalarFromVectorValue(l.tag, l.value);
        expect(toHex32(hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalar))).toBe(l.expected_leaf_hex.toLowerCase());
      }
    }
  });

  // The file's own _comment asserts redactedArtifactVectors' three disclosed openings are the SAME
  // keyPath/saltHex/value/expected_leaf_hex tuples as merkleVectors[0] ("size_3_pet_profile_promotion")
  // byte-for-byte - not merely each internally self-consistent with hashLeaf (the test above), but
  // literally reused ACROSS the two vector sections. Nothing until now turned red if that drifted (a
  // future regeneration could change merkleVectors[0]'s salts without touching redactedArtifactVectors,
  // or vice versa, and every other test here would keep passing). This derives the expectation from
  // merkleVectors[0] itself, keyed on keyPath - never a hardcoded literal - closing that gap.
  it("the _comment's cross-section reuse claim: profile_tree_base_full_artifact.disclosed is keyPath-for-keyPath identical to merkleVectors[0]'s leaves (saltHex, tag, value, expected_leaf_hex)", () => {
    const base = file.redactedArtifactVectors.find((v) => v.name === "profile_tree_base_full_artifact")!;
    const mv = file.merkleVectors.find((v) => v.name === "size_3_pet_profile_promotion")!;
    expect(base.disclosed.length, "guards a vacuous comparison if either side is ever emptied").toBe(3);
    expect(base.disclosed.length).toBe(mv.leaves.length);
    for (const d of base.disclosed) {
      const m = mv.leaves.find((l) => l.keyPath === d.keyPath);
      expect(m, `merkleVectors[0] has no leaf for keyPath ${d.keyPath}`).toBeDefined();
      expect(d.saltHex.toLowerCase()).toBe(m!.saltHex.toLowerCase());
      expect(d.tag).toBe(m!.tag);
      expect(d.value).toBe(m!.value);
      expect(d.expected_leaf_hex.toLowerCase()).toBe(m!.expected_leaf_hex.toLowerCase());
    }
  });

  it("masking never moves the root: profile_tree_base_full_artifact, masked_variant_species_obfuscated, and masked_variant_fully_obfuscated share the identical root_hex", () => {
    const names = ["profile_tree_base_full_artifact", "masked_variant_species_obfuscated", "masked_variant_fully_obfuscated"];
    const roots = new Set(names.map((n) => file.redactedArtifactVectors.find((v) => v.name === n)!.root_hex.toLowerCase()));
    expect(roots.size, "all three must share exactly one root").toBe(1);
  });

  it("the reserved-relabel bite proof: the naive leaf multiset really is identical to the masked-species vector's (independently recomputed via buildMerkle, not merely asserted)", () => {
    const masked = file.redactedArtifactVectors.find((v) => v.name === "masked_variant_species_obfuscated")!;
    const relabeled = file.redactedArtifactVectors.find((v) => v.name === "negative_reserved_relabeled_as_obfuscated")!;

    const maskedLeaves = [
      ...masked.reservedLeafHashes.map(fromHex32),
      ...masked.obfuscatedLeafHashes.map(fromHex32),
      ...masked.disclosed.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalarFromVectorValue(l.tag, l.value))),
    ];
    const relabeledLeaves = [
      ...relabeled.reservedLeafHashes.map(fromHex32),
      ...relabeled.obfuscatedLeafHashes.map(fromHex32),
      ...relabeled.disclosed.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalarFromVectorValue(l.tag, l.value))),
    ];
    const maskedRoot = toHex32(buildMerkle(maskedLeaves).root);
    const relabeledRoot = toHex32(buildMerkle(relabeledLeaves).root);

    expect(relabeledRoot, "the relabeled multiset must recompute the SAME root as the masked-species vector").toBe(maskedRoot);
    expect(relabeled.root_hex.toLowerCase()).toBe(maskedRoot);
    // ...and despite that, verifyRedactedArtifact still rejects it (only 2 reservedLeafHashes).
    expect(relabeled.reservedLeafHashes.length).toBe(2);
    expect(
      verifyRedactedArtifact({
        protocolVersion: "dogtag-v2/1",
        dogTagIdField: "1",
        issuerClone: "0x" + "11".repeat(20),
        root: relabeled.root_hex,
        disclosed: relabeled.disclosed.map(toOpened),
        obfuscatedLeafHashes: relabeled.obfuscatedLeafHashes,
        reservedLeafHashes: relabeled.reservedLeafHashes,
      }),
    ).toBe(false);
  });
});

describe("redactedArtifactVectors - the isolating negatives promoted from testvectors.json (WP4.10S P1)", () => {
  // The exact 6 vectors scripts/promote-spec-vectors.ts copies from packages/dogtag-standard-ts/
  // testvectors.json's redactedArtifacts, each constructed so its root is the GENUINE root of its
  // own exact leaf multiset - so only the ONE structural check it names can be the reason
  // verifyRedactedArtifact rejects it (specs/leaf-commitment.md section 15's worked examples name
  // each one explicitly). Listed again here independently, not imported from the promotion script,
  // so this test keeps checking what the SPEC claims even if the script's own list ever changes -
  // the same "independent transcription, not a shared import" discipline redactedArtifact.ts itself
  // documents for its own duplicated helpers.
  const PROMOTED_NAMES = [
    "negative_overlap_root_preserving_duplicate_leaf",
    "negative_overlap_reserved_half_matches_disclosed",
    "negative_duplicate_pet_keypath_no_identity_oracle",
    "negative_65_leaves_genuine_root_over_cap",
    "negative_hex32_shape_reserved_missing_0x_prefix",
    "negative_hex32_shape_obfuscated_missing_0x_prefix",
  ];

  it("pins the promoted count (guards a future promotion silently shrinking this set)", () => {
    expect(PROMOTED_NAMES.length).toBe(6);
  });

  it("all 6 are present in specs/leaf-commitment-vectors.json, and every one is a deliberately-invalid (valid: false) vector", () => {
    for (const name of PROMOTED_NAMES) {
      const v = file.redactedArtifactVectors.find((v) => v.name === name);
      expect(v, `${name} missing from specs/leaf-commitment-vectors.json's redactedArtifactVectors`).toBeDefined();
      expect(v!.valid, `${name} should be a negative (rejected) vector`).toBe(false);
    }
  });

  // This is the drift guard the promotion script's self-checks (recompute the root, re-run
  // verifyRedactedArtifact) do not themselves cover: nothing before this stopped a future
  // `pnpm gen-vectors` run from moving testvectors.json's same-named vector (new salts, a
  // regenerated root) while specs/leaf-commitment-vectors.json silently kept the stale copy - every
  // OTHER test in this file only checks the curated JSON against the implementation, never the two
  // vectors files against each other. Field-for-field, not a whole-object deep-equal, because the
  // curated side carries two EXTRA per-leaf fields (tagName, expected_leaf_hex) testvectors.json's
  // wire shape does not.
  it("every promoted vector is field-for-field identical to its same-named testvectors.json source (a promotion, not a re-invention)", () => {
    for (const name of PROMOTED_NAMES) {
      const curated = file.redactedArtifactVectors.find((v) => v.name === name)!;
      const source = oldFile.redactedArtifacts.find((v) => v.name === name);
      expect(source, `${name} missing from testvectors.json's redactedArtifacts - nothing to promote FROM`).toBeDefined();

      expect(curated.disclosed.length, `${name}: disclosed.length must match its source`).toBe(source!.disclosed.length);
      curated.disclosed.forEach((l, i) => {
        const s = source!.disclosed[i]!;
        expect(l.keyPath, `${name}.disclosed[${i}].keyPath`).toBe(s.keyPath);
        expect(l.saltHex.toLowerCase(), `${name}.disclosed[${i}].saltHex`).toBe(s.saltHex.toLowerCase());
        expect(l.tag, `${name}.disclosed[${i}].tag`).toBe(s.tag);
        expect(l.value, `${name}.disclosed[${i}].value`).toBe(s.value);
      });
      expect(
        curated.obfuscatedLeafHashes.map((h) => h.toLowerCase()),
        `${name}.obfuscatedLeafHashes`,
      ).toEqual(source!.obfuscatedLeafHashes.map((h) => h.toLowerCase()));
      expect(
        curated.reservedLeafHashes.map((h) => h.toLowerCase()),
        `${name}.reservedLeafHashes`,
      ).toEqual(source!.reservedLeafHashes.map((h) => h.toLowerCase()));
      expect(curated.root_hex.toLowerCase(), `${name}.root_hex vs source root`).toBe(source!.root.toLowerCase());
      expect(curated.valid, `${name}.valid`).toBe(source!.valid);
    }
  });
});

describe("recordArtifactVectors - verifyRecordArtifact reproduces every recorded outcome (section 16)", () => {
  function toOpened(l: RecordArtifactWireLeaf): OpenedLeaf {
    return {keyPath: l.keyPath, saltHex: l.saltHex, tag: l.tag, value: l.value};
  }

  it("carries at least 2 masked-but-valid variants and at least 3 deliberately-invalid negatives", () => {
    const valid = file.recordArtifactVectors.filter((v) => v.valid);
    const invalid = file.recordArtifactVectors.filter((v) => !v.valid);
    // The FIRST valid entry is the unmasked base (nothing obfuscated) - not itself a "masked
    // variant" - so this counts only entries that actually obfuscate at least one leaf.
    const maskedVariants = valid.filter((v) => v.obfuscatedLeafHashes.length > 0);
    expect(maskedVariants.length, "masked (obfuscatedLeafHashes non-empty) but still-valid vectors").toBeGreaterThanOrEqual(2);
    expect(invalid.length).toBeGreaterThanOrEqual(3);
  });

  for (const v of file.recordArtifactVectors) {
    it(`${v.name}: verifyRecordArtifact returns ${v.valid}`, () => {
      const artifact: RecordArtifact = {
        protocolVersion: "dogtag-v2/1",
        artifactType: "record",
        root: v.root_hex,
        disclosed: v.disclosed.map(toOpened),
        obfuscatedLeafHashes: v.obfuscatedLeafHashes,
        reservedLeafHashes: v.reservedLeafHashes,
      };
      expect(verifyRecordArtifact(artifact)).toBe(v.valid);
    });
  }

  it("every disclosed leaf's expected_leaf_hex matches hashLeaf, independent of verifyRecordArtifact itself", () => {
    for (const v of file.recordArtifactVectors) {
      for (const l of v.disclosed) {
        const scalar = scalarFromVectorValue(l.tag, l.value);
        const h = hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalar);
        expect(toHex32(h), `${v.name}: ${l.keyPath}`).toBe(l.expected_leaf_hex.toLowerCase());
      }
    }
  });

  it("the three positive variants (full, masked-clinical-leaf, masked-except-non-maskable) share the identical root - masking never moves it", () => {
    const names = ["record_full_artifact", "record_masked_clinical_leaf", "record_masked_except_non_maskable"];
    const roots = new Set(names.map((n) => file.recordArtifactVectors.find((v) => v.name === n)!.root_hex.toLowerCase()));
    expect(roots.size, `${names.join(", ")} should all share one root`).toBe(1);
  });

  it("record_negative_masked_dogtagid shares that SAME root - the bookkeeping move, not the root, is what's rejected", () => {
    const full = file.recordArtifactVectors.find((v) => v.name === "record_full_artifact")!;
    const negative = file.recordArtifactVectors.find((v) => v.name === "record_negative_masked_dogtagid")!;
    expect(negative.root_hex.toLowerCase()).toBe(full.root_hex.toLowerCase());
    expect(verifyRecordArtifact({
      protocolVersion: "dogtag-v2/1",
      artifactType: "record",
      root: negative.root_hex,
      disclosed: negative.disclosed.map(toOpened),
      obfuscatedLeafHashes: negative.obfuscatedLeafHashes,
      reservedLeafHashes: negative.reservedLeafHashes,
    })).toBe(false);
  });

  it("every negative vector's root_hex is the GENUINE root of its own posted multiset (isolating, per section 13/16 - never an incidental root mismatch)", () => {
    for (const v of file.recordArtifactVectors.filter((v) => !v.valid)) {
      const disclosedHashes = v.disclosed.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalarFromVectorValue(l.tag, l.value)));
      const obfuscatedFields = v.obfuscatedLeafHashes.map(fromHex32);
      const reservedFields = v.reservedLeafHashes.map(fromHex32);
      const recomputedRoot = toHex32(buildMerkle([...reservedFields, ...obfuscatedFields, ...disclosedHashes]).root);
      expect(recomputedRoot, `${v.name}: root_hex must be the genuine root of its own posted multiset`).toBe(v.root_hex.toLowerCase());
    }
  });
});

describe("leaf-commitment.md's quoted worked-example values are not hand-typed drift from the vectors file", () => {
  // Every 32-byte hex value leaf-commitment.md quotes in prose (worked examples in sections 6-11)
  // must actually come FROM specs/leaf-commitment-vectors.json - otherwise the spec could silently
  // diverge from the JSON (e.g. after regenerating vectors with different salts) while every other
  // test in this file keeps passing, because those tests check the JSON against the implementation,
  // never the markdown against the JSON. This closes that gap.
  const hexInSpec = Array.from(new Set(specText.match(/0x[0-9a-fA-F]{64}/g) ?? [])).map((h) => h.toLowerCase());

  it("the spec quotes at least one 32-byte hex value (guards a regex/extraction bug making this vacuous)", () => {
    expect(hexInSpec.length).toBeGreaterThan(5);
  });

  for (const hex of hexInSpec) {
    it(`spec-quoted hex ${hex} appears in leaf-commitment-vectors.json or testvectors.json`, () => {
      const inNewVectors = vectorsRawText.toLowerCase().includes(hex);
      const inOldVectors = oldTestvectorsRawText.toLowerCase().includes(hex);
      expect(
        inNewVectors || inOldVectors,
        `${hex} was not found in either vectors file - it may be hand-typed / drifted`,
      ).toBe(true);
    });
  }

  it("the spec's dogTagIdField(\"424242\") decimal worked example matches the vectors file", () => {
    const decimalInSpec = specText.includes(
      "19282080935305080861096842252900215298393603684181619512414474199363734335896",
    );
    expect(decimalInSpec).toBe(true);
    expect(
      vectorsRawText.includes("19282080935305080861096842252900215298393603684181619512414474199363734335896"),
    ).toBe(true);
  });

  // N1 fix: the hex-drift checks above catch a HASH drifting from the vectors file, but D2 was a WORD
  // defect (wrong sort order, wrong promoted leaf) that changed no hex token at all - restoring the
  // pre-fix sentences leaves every hex cross-check above green. These two assertions close that gap by
  // deriving their expectation from merkleVectors[0] itself, never a hardcoded literal, so a future
  // vector regeneration keeps them honest automatically.
  const short = (kp: string) => kp.replace(/^credentialSubject\./, "");

  // Lifted to describe scope (was local to the PAIRED-leaves assertion below) so the N5 sort-order
  // assertion can reuse the exact same sorted-by-hash leaf list instead of recomputing it a third way.
  const tv = file.merkleVectors.find((v) => v.name === "size_3_pet_profile_promotion")!;
  const withHashes = tv.leaves.map((l) => ({
    keyPath: l.keyPath,
    hash: hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalarFromVectorValue(l.tag, l.value)),
  }));
  // Exactly the way "the recorded promoted leaf is the numerically-largest leaf hash" above computes
  // its own expectation: sort ascending, the promoted leaf is the largest, everything else was paired.
  const sorted = [...withHashes].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

  it("the spec's worked-example prose names the correct PROMOTED leaf (derived from merkleVectors[0], pins the D2 regression)", () => {
    const match = specText.match(/PROMOTES the remaining largest leaf \(`([^`]+)`\)/);
    expect(match, "expected a 'PROMOTES the remaining largest leaf (`...`)' sentence in the spec prose").not.toBeNull();
    expect(match![1]).toBe(short(tv.promoted_leaf_keyPath));
  });

  it("the spec's worked-example prose names the correct PAIRED (non-promoted) leaves, derived from merkleVectors[0]'s own leaf hashes", () => {
    const nonPromoted = sorted.slice(0, -1);

    const match = specText.match(/pairs the two smallest \(`([^`]+)`, `([^`]+)`\)/);
    expect(match, "expected a 'pairs the two smallest (`...`, `...`)' sentence in the spec prose").not.toBeNull();
    const namedInSpec = new Set([match![1], match![2]]);
    const expectedFromVectors = new Set(nonPromoted.map((l) => short(l.keyPath)));
    expect(namedInSpec).toEqual(expectedFromVectors);
  });

  // N5 fix: N1 pinned the PROMOTED leaf and the PAIRED leaves, but D2 was a three-claim prose defect
  // and the SORT-ORDER sentence itself ("Sorted ascending, the `name` leaf is smallest and the
  // `species` leaf is largest.") was still unpinned - reverting only that sentence left both
  // assertions above green and changed no hex token, so the full suite stayed green too. This closes
  // that gap the same way: derived from the same `sorted` array above, never hardcoded.
  it("the spec's worked-example prose states the correct SORT ORDER (derived from merkleVectors[0], pins the N5 residual)", () => {
    const match = specText.match(
      /Sorted ascending, the `([^`]+)` leaf is smallest and the `([^`]+)` leaf is largest/,
    );
    expect(
      match,
      "expected a 'Sorted ascending, the `...` leaf is smallest and the `...` leaf is largest' sentence in the spec prose",
    ).not.toBeNull();
    expect(match![1]).toBe(short(sorted[0]!.keyPath));
    expect(match![2]).toBe(short(sorted[sorted.length - 1]!.keyPath));
  });
});
