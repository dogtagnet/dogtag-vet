// S2 registry conformance for specs/schemas/dogtag.record-artifact.v1.schema.json (WP4.14S) - the
// record-artifact sibling of redacted_artifact_schema.test.ts, following the identical discipline
// specs/schemas/README.md's Conformance section states applies to both: this schema has no
// schema.ts/validateSchema counterpart (a RecordArtifact is not a schema.ts-validated credential), so
// its "code" side is verifyRecordArtifact's own STRUCTURAL checks, proven BIDIRECTIONAL the same way:
//   1. Every fixture the JSON SCHEMA accepts, verifyRecordArtifact's structural checks accept too
//      (never registry-looser-than-code).
//   2. Every fixture broken in a way the JSON SCHEMA rejects, verifyRecordArtifact ALSO rejects
//      (never registry-stricter-than-code, and never merely cosmetic).
// Positive fixtures are the REAL, implementation-computed vectors from
// specs/leaf-commitment-vectors.json's recordArtifactVectors (section 16) - genuinely valid both in
// shape AND in the cryptographic sense verifyRecordArtifact actually checks, not merely
// shape-plausible. This schema deliberately says nothing about root recomputation, the non-maskable-
// set-must-be-disclosed rule, or the overlap rule (specs/schemas/README.md: shape and leaf-commitment
// encoding are independent axes) - only shape is asserted here.
import {describe, it, expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {verifyRecordArtifact, type RecordArtifact} from "../src/recordArtifact.js";
import type {OpenedLeaf} from "../src/profileBind.js";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCHEMA_PATH = resolve(REPO_ROOT, "specs", "schemas", "dogtag.record-artifact.v1.schema.json");
const VECTORS_PATH = resolve(REPO_ROOT, "specs", "leaf-commitment-vectors.json");

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({strict: true, allErrors: true});
ajv.addKeyword({keyword: "version"});
ajv.addKeyword({keyword: "x-validationRules"});
const validate = ajv.compile(schema);

interface RecordArtifactWireLeaf {
  keyPath: string;
  saltHex: string;
  tag: number;
  value: string;
}
interface RecordArtifactVector {
  name: string;
  disclosed: RecordArtifactWireLeaf[];
  obfuscatedLeafHashes: string[];
  reservedLeafHashes: string[];
  root_hex: string;
  valid: boolean;
}
const vectorsFile = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as {recordArtifactVectors: RecordArtifactVector[]};

function envelopeOf(v: RecordArtifactVector): RecordArtifact {
  return {
    protocolVersion: "dogtag-v2/1",
    artifactType: "record",
    root: v.root_hex,
    disclosed: v.disclosed.map((l) => ({keyPath: l.keyPath, saltHex: l.saltHex, tag: l.tag, value: l.value}) as OpenedLeaf),
    obfuscatedLeafHashes: v.obfuscatedLeafHashes,
    reservedLeafHashes: v.reservedLeafHashes,
  };
}

describe("dogtag.record-artifact.v1.schema.json - shape validation", () => {
  it("compiles under ajv strict (draft 2020-12)", () => {
    expect(typeof validate).toBe("function");
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://dogtag.io/schemas/record-artifact/v1");
  });

  // Only record_negative_reserved_present violates the schema's own reservedLeafHashes maxItems:0 -
  // every other vector, valid or not, is individually well-formed by SHAPE (the non-maskable-set and
  // overlap rules its other two negatives isolate are cross-field/cross-array VALUE comparisons no
  // generic JSON Schema keyword can express here).
  const SHAPE_INVALID_VECTOR_NAMES = new Set(["record_negative_reserved_present"]);

  describe("positive: every SHAPE-valid recordArtifactVectors entry validates, full or masked alike", () => {
    for (const v of vectorsFile.recordArtifactVectors.filter((v) => !SHAPE_INVALID_VECTOR_NAMES.has(v.name))) {
      it(`${v.name} (disclosed.length=${v.disclosed.length}, obfuscatedLeafHashes.length=${v.obfuscatedLeafHashes.length})`, () => {
        const artifact = envelopeOf(v);
        const ok = validate(artifact);
        expect(ok, JSON.stringify(validate.errors)).toBe(true);
      });
    }
  });

  it("accepts an artifact with the optional schemaId field present", () => {
    const base = envelopeOf(vectorsFile.recordArtifactVectors.find((v) => v.name === "record_full_artifact")!);
    const withOptional = {...base, schemaId: "https://dogtag.io/schemas/vaccination/v1"};
    expect(validate(withOptional), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts an artifact with schemaId ABSENT (open-world, matches the rest of this registry)", () => {
    const base = envelopeOf(vectorsFile.recordArtifactVectors.find((v) => v.name === "record_full_artifact")!);
    expect((base as Record<string, unknown>).schemaId).toBeUndefined();
    expect(validate(base), JSON.stringify(validate.errors)).toBe(true);
  });

  it("record_negative_reserved_present is schema-INVALID (shape: reservedLeafHashes has 1 entry, violates maxItems:0) - here shape and crypto agree, unlike the redacted-tag-artifact case where the corresponding vector's root happened to be bit-identical to a genuine one", () => {
    const v = vectorsFile.recordArtifactVectors.find((v) => v.name === "record_negative_reserved_present")!;
    expect(v.reservedLeafHashes.length).toBe(1);
    const artifact = envelopeOf(v);
    expect(validate(artifact)).toBe(false);
    expect(verifyRecordArtifact(artifact)).toBe(false);
  });

  it("record_negative_masked_dogtagid IS schema-valid (every hash/opening individually well-formed; the non-maskable-set rule is a cross-array VALUE comparison no generic JSON Schema keyword expresses here) even though verifyRecordArtifact rejects it - the crypto layer catches exactly what the shape layer structurally cannot", () => {
    const v = vectorsFile.recordArtifactVectors.find((v) => v.name === "record_negative_masked_dogtagid")!;
    expect(v.valid).toBe(false);
    const artifact = envelopeOf(v);
    expect(validate(artifact), JSON.stringify(validate.errors)).toBe(true);
    expect(verifyRecordArtifact(artifact)).toBe(false);
  });

  it("record_negative_overlap IS schema-valid (same reasoning: overlap is a cross-array VALUE comparison) even though verifyRecordArtifact rejects it", () => {
    const v = vectorsFile.recordArtifactVectors.find((v) => v.name === "record_negative_overlap")!;
    expect(v.valid).toBe(false);
    const artifact = envelopeOf(v);
    expect(validate(artifact), JSON.stringify(validate.errors)).toBe(true);
    expect(verifyRecordArtifact(artifact)).toBe(false);
  });

  // The remaining cell of the shape-vs-crypto matrix (mirrors redacted_artifact_schema.test.ts's own
  // "a hex dogTagIdField..." test): verifyRecordArtifact destructures only
  // root/disclosed/obfuscatedLeafHashes/reservedLeafHashes (recordArtifact.ts's own doc comment lists
  // exactly these four) and never reads `artifactType` at all, so an artifactType value the SCHEMA
  // rejects can still be CRYPTO-valid. Pinned here, not added to negativeCases below (whose
  // bidirectional loop asserts verifyRecordArtifact === false for every entry - these two would be
  // false to assert).
  it("artifactType \"tag\" is schema-INVALID (const mismatch) even though the artifact is otherwise crypto-VALID - verifyRecordArtifact never reads this field at all", () => {
    const v = vectorsFile.recordArtifactVectors.find((v) => v.name === "record_full_artifact")!;
    const artifact = {...envelopeOf(v), artifactType: "tag"};
    expect(validate(artifact), JSON.stringify(validate.errors)).toBe(false);
    expect(verifyRecordArtifact(artifact as unknown as RecordArtifact)).toBe(true);
  });

  it("a missing artifactType is schema-INVALID (required) even though the artifact is otherwise crypto-VALID - same reason as above", () => {
    const v = vectorsFile.recordArtifactVectors.find((v) => v.name === "record_full_artifact")!;
    const artifact = envelopeOf(v) as Record<string, unknown>;
    delete artifact.artifactType;
    expect(validate(artifact), JSON.stringify(validate.errors)).toBe(false);
    expect(verifyRecordArtifact(artifact as unknown as RecordArtifact)).toBe(true);
  });

  describe("BIDIRECTIONAL: every shape-valid, crypto-valid vector is accepted by BOTH layers (registry never looser than the leaf-commitment layer)", () => {
    for (const v of vectorsFile.recordArtifactVectors.filter((v) => v.valid && !SHAPE_INVALID_VECTOR_NAMES.has(v.name))) {
      it(`${v.name}: schema-valid AND verifyRecordArtifact(...) === true`, () => {
        const artifact = envelopeOf(v);
        expect(validate(artifact)).toBe(true);
        expect(verifyRecordArtifact(artifact)).toBe(true);
      });
    }
  });

  interface NegativeCase {
    name: string;
    mutate: (a: Record<string, unknown>) => void;
  }

  const negativeCases: NegativeCase[] = [
    {
      name: "reservedLeafHashes has 1 entry (violates maxItems:0)",
      mutate: (a) => {
        a.reservedLeafHashes = ["0x" + "42".repeat(32)];
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
  ];

  it("pins the enumerated negative-case count (guards a case silently dropped)", () => {
    expect(negativeCases.length).toBe(8);
  });

  describe("negative: a structurally-broken artifact is rejected by the schema", () => {
    for (const nc of negativeCases) {
      it(nc.name, () => {
        const base = envelopeOf(vectorsFile.recordArtifactVectors.find((v) => v.name === "record_full_artifact")!);
        const broken = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
        nc.mutate(broken);
        expect(validate(broken), `expected the schema to reject: ${nc.name}`).toBe(false);
      });
    }
  });

  describe("BIDIRECTIONAL: every schema-rejected structural break is ALSO rejected by verifyRecordArtifact (registry never stricter, and never merely cosmetic)", () => {
    for (const nc of negativeCases) {
      it(`${nc.name}: schema-invalid AND verifyRecordArtifact(...) === false`, () => {
        const base = envelopeOf(vectorsFile.recordArtifactVectors.find((v) => v.name === "record_full_artifact")!);
        const broken = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
        nc.mutate(broken);
        expect(validate(broken)).toBe(false);
        expect(verifyRecordArtifact(broken as unknown as RecordArtifact)).toBe(false);
      });
    }
  });
});
