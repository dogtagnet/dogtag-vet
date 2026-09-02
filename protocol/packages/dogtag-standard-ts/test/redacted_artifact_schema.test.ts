// S2 registry conformance for specs/schemas/dogtag.redacted-tag-artifact.v1.schema.json (WP4.10S
// item 5) - a SEPARATE, narrower harness than schema_registry.test.ts's, because this schema
// describes a different KIND of thing than the five VC record types that harness governs: a
// RedactedTagArtifact is not a schema.ts-validated credential (no recordType, no envelope
// composition, no validateSchema counterpart to cross-check against). Its "code" side is
// verifyRedactedArtifact's own STRUCTURAL checks (redactedArtifact.ts steps 1-2: exactly 3 reserved
// hashes, hex32 shape, tag range) - the registry's shape layer and the leaf-commitment layer's
// structural pre-checks are two independent descriptions of the same wire shape, and this file
// proves them BIDIRECTIONAL, the same discipline schema_registry.test.ts already applies to the
// five VC schemas (per specs/schemas/README.md's "Conformance" section):
//   1. Every fixture the JSON SCHEMA accepts, verifyRedactedArtifact's structural checks accept too
//      (never registry-looser-than-code).
//   2. Every fixture broken in a way the JSON SCHEMA rejects, verifyRedactedArtifact ALSO rejects
//      (never registry-stricter-than-code, and never registry-only-superficial).
// Positive fixtures are the REAL, implementation-generated vectors from
// specs/leaf-commitment-vectors.json's redactedArtifactVectors (section 15) - genuinely valid both
// in shape AND in the cryptographic sense verifyRedactedArtifact actually checks, not merely
// shape-plausible. This schema deliberately says nothing about root recomputation (specs/schemas/
// README.md: shape and leaf-commitment encoding are independent axes) - only shape is asserted here.
import {describe, it, expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {verifyRedactedArtifact, type RedactedTagArtifact} from "../src/redactedArtifact.js";
import type {OpenedLeaf} from "../src/profileBind.js";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCHEMA_PATH = resolve(REPO_ROOT, "specs", "schemas", "dogtag.redacted-tag-artifact.v1.schema.json");
const VECTORS_PATH = resolve(REPO_ROOT, "specs", "leaf-commitment-vectors.json");

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({strict: true, allErrors: true});
ajv.addKeyword({keyword: "version"});
ajv.addKeyword({keyword: "x-validationRules"});
const validate = ajv.compile(schema);

interface RedactedArtifactWireLeaf {
  keyPath: string;
  saltHex: string;
  tag: number;
  value: string;
}
interface RedactedArtifactVector {
  name: string;
  disclosed: RedactedArtifactWireLeaf[];
  obfuscatedLeafHashes: string[];
  reservedLeafHashes: string[];
  root_hex: string;
  valid: boolean;
}
const vectorsFile = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as {redactedArtifactVectors: RedactedArtifactVector[]};

function envelopeOf(v: RedactedArtifactVector): RedactedTagArtifact {
  return {
    protocolVersion: "dogtag-v2/1",
    dogTagIdField: "19282080935305080861096842252900215298393603684181619512414474199363734335896",
    root: v.root_hex,
    disclosed: v.disclosed.map((l) => ({keyPath: l.keyPath, saltHex: l.saltHex, tag: l.tag, value: l.value}) as OpenedLeaf),
    obfuscatedLeafHashes: v.obfuscatedLeafHashes,
    reservedLeafHashes: v.reservedLeafHashes,
    issuerClone: "0x" + "11".repeat(20),
  };
}

describe("dogtag.redacted-tag-artifact.v1.schema.json - shape validation", () => {
  it("compiles under ajv strict (draft 2020-12)", () => {
    expect(typeof validate).toBe("function");
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://dogtag.io/schemas/redacted-tag-artifact/v1");
  });

  // Shape validity and verifyRedactedArtifact's crypto verdict (`v.valid`) are INDEPENDENT axes
  // (specs/schemas/README.md: "the canonical encoding layer... this registry's job is narrower").
  // `negative_overlap` is a perfect illustration: every hash in it is individually well-formed, so
  // its SHAPE is fine (schema-valid) even though `verifyRedactedArtifact` rejects it on overlap - a
  // check no generic JSON Schema keyword can express (it would need to compare VALUES across two
  // different array properties for set-membership, which 2020-12 has no keyword for here).
  // `negative_reserved_relabeled_as_obfuscated` is the opposite illustration: it has only 2
  // `reservedLeafHashes`, a SHAPE violation the schema's `minItems: 3` catches directly, even though
  // its root is bit-identical to a genuine artifact's (section 15's own worked example).
  // `negative_hex32_shape_reserved_missing_0x_prefix` and `..._obfuscated_missing_0x_prefix` (WP4.10S
  // P1 promotion) are a THIRD illustration of the same independence, on the opposite check from
  // `negative_reserved_relabeled_as_obfuscated`: each has an otherwise-genuine 64-hex-char hash with
  // its "0x" stripped, which the schema's `hex32` pattern (`^0x[0-9a-fA-F]{64}$`) requires and
  // therefore rejects on SHAPE, even though the leaf-commitment layer's own parser (`fromHex32`)
  // treats the prefix as optional and folds the identical field element into a genuine root either
  // way - `verifyRedactedArtifact` rejects these two for a DIFFERENT reason (its own, stricter hex32
  // shape check, isHex32, which - unlike fromHex32 - does require the prefix): see the dedicated
  // test below for both halves of that claim, proven rather than merely asserted by exclusion here.
  const SHAPE_INVALID_VECTOR_NAMES = new Set([
    "negative_reserved_relabeled_as_obfuscated",
    "negative_hex32_shape_reserved_missing_0x_prefix",
    "negative_hex32_shape_obfuscated_missing_0x_prefix",
  ]);

  describe("positive: every SHAPE-valid redactedArtifactVectors entry (specs/leaf-commitment-vectors.json) validates, whether full, masked, or fully-obfuscated", () => {
    for (const v of vectorsFile.redactedArtifactVectors.filter((v) => !SHAPE_INVALID_VECTOR_NAMES.has(v.name))) {
      it(`${v.name} (disclosed.length=${v.disclosed.length}, obfuscatedLeafHashes.length=${v.obfuscatedLeafHashes.length})`, () => {
        const artifact = envelopeOf(v);
        const ok = validate(artifact);
        expect(ok, JSON.stringify(validate.errors)).toBe(true);
      });
    }
  });

  it("accepts an artifact with both optional fields (schemaId, dogTagIdDec) present", () => {
    const base = envelopeOf(vectorsFile.redactedArtifactVectors.find((v) => v.name === "profile_tree_base_full_artifact")!);
    const withOptionals = {...base, schemaId: "https://dogtag.io/schemas/dog-profile/v1", dogTagIdDec: "424242"};
    expect(validate(withOptionals), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts an artifact with both optional fields ABSENT (open-world: no additionalProperties restriction, matches the rest of this registry)", () => {
    const base = envelopeOf(vectorsFile.redactedArtifactVectors.find((v) => v.name === "profile_tree_base_full_artifact")!);
    expect((base as Record<string, unknown>).schemaId).toBeUndefined();
    expect((base as Record<string, unknown>).dogTagIdDec).toBeUndefined();
    expect(validate(base), JSON.stringify(validate.errors)).toBe(true);
  });

  it("negative_reserved_relabeled_as_obfuscated is schema-INVALID (shape: only 2 reservedLeafHashes) despite carrying a bit-identical, otherwise-genuine root - shape and leaf-commitment encoding are independent axes", () => {
    const v = vectorsFile.redactedArtifactVectors.find((v) => v.name === "negative_reserved_relabeled_as_obfuscated")!;
    expect(v.reservedLeafHashes.length).toBe(2);
    const artifact = envelopeOf(v);
    expect(validate(artifact)).toBe(false);
    expect(verifyRedactedArtifact(artifact)).toBe(false);
  });

  it("negative_hex32_shape_reserved_missing_0x_prefix is schema-INVALID (shape: reservedLeafHashes[0] missing its \"0x\" prefix) despite recomputing a genuine root - the registry's hex32 pattern requires the literal prefix even though the leaf-commitment layer's own fromHex32 parser treats it as optional", () => {
    const v = vectorsFile.redactedArtifactVectors.find((v) => v.name === "negative_hex32_shape_reserved_missing_0x_prefix")!;
    expect(v.reservedLeafHashes[0]!.startsWith("0x")).toBe(false);
    const artifact = envelopeOf(v);
    expect(validate(artifact), JSON.stringify(validate.errors)).toBe(false);
    // verifyRedactedArtifact ALSO rejects it - but via its own isHex32 shape check (step 1), a
    // DIFFERENT reason than the schema's pattern mismatch; redacted_artifact.test.ts's D4 bite-proof
    // tests pin that this specific check (not e.g. a root mismatch) is what does the rejecting there.
    expect(verifyRedactedArtifact(artifact)).toBe(false);
  });

  it("negative_hex32_shape_obfuscated_missing_0x_prefix is schema-INVALID (shape: obfuscatedLeafHashes[0] missing its \"0x\" prefix) despite recomputing a genuine root - same independence as the reserved-half vector above, on the other array this check covers", () => {
    const v = vectorsFile.redactedArtifactVectors.find((v) => v.name === "negative_hex32_shape_obfuscated_missing_0x_prefix")!;
    expect(v.obfuscatedLeafHashes[0]!.startsWith("0x")).toBe(false);
    const artifact = envelopeOf(v);
    expect(validate(artifact), JSON.stringify(validate.errors)).toBe(false);
    expect(verifyRedactedArtifact(artifact)).toBe(false);
  });

  it("negative_overlap IS schema-valid (every hash is individually well-formed; overlap is a cross-array VALUE comparison no generic JSON Schema keyword expresses here) even though verifyRedactedArtifact rejects it - the crypto layer catches exactly what the shape layer structurally cannot", () => {
    const v = vectorsFile.redactedArtifactVectors.find((v) => v.name === "negative_overlap")!;
    expect(v.valid).toBe(false);
    const artifact = envelopeOf(v);
    expect(validate(artifact), JSON.stringify(validate.errors)).toBe(true);
    expect(verifyRedactedArtifact(artifact)).toBe(false);
  });

  // The third cell of the shape-vs-crypto matrix: negative_reserved_relabeled_as_obfuscated is
  // schema-invalid+crypto-invalid, negative_overlap is schema-valid+crypto-invalid, and every
  // BIDIRECTIONAL vector below is schema-valid+crypto-valid - this is schema-INVALID+crypto-VALID,
  // the remaining combination. verifyRedactedArtifact never reads dogTagIdField at all (it
  // destructures only root/disclosed/obfuscatedLeafHashes/reservedLeafHashes - see
  // redactedArtifact.ts's own doc comment: "not itself checked by this pure verifier"), so a
  // dogTagIdField that violates the decimalString $def (hex instead of decimal - WP4.10S's own
  // remediation pass fixed exactly this mistake in every test fixture) makes an otherwise-genuine
  // artifact fail the SCHEMA while still passing the CRYPTO check. Pinned here, not added to
  // negativeCases below (whose bidirectional loop asserts verifyRedactedArtifact === false for
  // every entry - this one is the one negative case where that would be false to assert).
  it("a hex dogTagIdField (violates the decimalString $def) is schema-INVALID even though the artifact is otherwise crypto-VALID - verifyRedactedArtifact never reads this field at all", () => {
    const v = vectorsFile.redactedArtifactVectors.find((v) => v.name === "profile_tree_base_full_artifact")!;
    const artifact = {...envelopeOf(v), dogTagIdField: "0x01"};
    expect(validate(artifact), JSON.stringify(validate.errors)).toBe(false);
    expect(verifyRedactedArtifact(artifact)).toBe(true);
  });

  describe("BIDIRECTIONAL: every shape-valid, crypto-valid vector is accepted by BOTH layers (registry never looser than the leaf-commitment layer)", () => {
    for (const v of vectorsFile.redactedArtifactVectors.filter((v) => v.valid && !SHAPE_INVALID_VECTOR_NAMES.has(v.name))) {
      it(`${v.name}: schema-valid AND verifyRedactedArtifact(...) === true`, () => {
        const artifact = envelopeOf(v);
        expect(validate(artifact)).toBe(true);
        expect(verifyRedactedArtifact(artifact)).toBe(true);
      });
    }
  });

  interface NegativeCase {
    name: string;
    mutate: (a: Record<string, unknown>) => void;
  }

  const negativeCases: NegativeCase[] = [
    {
      name: "only 2 reservedLeafHashes",
      mutate: (a) => {
        a.reservedLeafHashes = (a.reservedLeafHashes as string[]).slice(0, 2);
      },
    },
    {
      name: "4 reservedLeafHashes",
      mutate: (a) => {
        a.reservedLeafHashes = [...(a.reservedLeafHashes as string[]), "0x" + "42".repeat(32)];
      },
    },
    {
      name: "root missing the 0x prefix",
      mutate: (a) => {
        a.root = (a.root as string).slice(2);
      },
    },
    {
      name: "root too short",
      mutate: (a) => {
        a.root = "0x1234";
      },
    },
    {
      name: "an obfuscatedLeafHashes entry is not hex",
      mutate: (a) => {
        a.obfuscatedLeafHashes = ["not-a-hash-at-all"];
      },
    },
    {
      name: "a disclosed leaf's tag is out of range (6)",
      mutate: (a) => {
        (a.disclosed as Record<string, unknown>[])[0]!.tag = 6;
      },
    },
    {
      name: "a disclosed leaf's tag is negative",
      mutate: (a) => {
        (a.disclosed as Record<string, unknown>[])[0]!.tag = -1;
      },
    },
    {
      name: "a disclosed leaf is missing `value`",
      mutate: (a) => {
        delete (a.disclosed as Record<string, unknown>[])[0]!.value;
      },
    },
    {
      name: "top-level `root` is missing entirely",
      mutate: (a) => {
        delete a.root;
      },
    },
    {
      name: "top-level `reservedLeafHashes` is missing entirely",
      mutate: (a) => {
        delete a.reservedLeafHashes;
      },
    },
  ];

  it("pins the enumerated negative-case count (guards a case silently dropped)", () => {
    expect(negativeCases.length).toBe(10);
  });

  describe("negative: a structurally-broken artifact is rejected by the schema", () => {
    for (const nc of negativeCases) {
      it(nc.name, () => {
        const base = envelopeOf(vectorsFile.redactedArtifactVectors.find((v) => v.name === "profile_tree_base_full_artifact")!);
        const broken = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
        nc.mutate(broken);
        expect(validate(broken), `expected the schema to reject: ${nc.name}`).toBe(false);
      });
    }
  });

  describe("BIDIRECTIONAL: every schema-rejected structural break is ALSO rejected by verifyRedactedArtifact (registry never stricter, and never merely cosmetic)", () => {
    for (const nc of negativeCases) {
      it(`${nc.name}: schema-invalid AND verifyRedactedArtifact(...) === false`, () => {
        const base = envelopeOf(vectorsFile.redactedArtifactVectors.find((v) => v.name === "profile_tree_base_full_artifact")!);
        const broken = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
        nc.mutate(broken);
        expect(validate(broken)).toBe(false);
        expect(verifyRedactedArtifact(broken as unknown as RedactedTagArtifact)).toBe(false);
      });
    }
  });
});
