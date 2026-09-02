import {describe, expect, it} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {redactedTagArtifactSchema} from "@/lib/schemas/redactedArtifact";

/**
 * WP4.10V fix round 1, D5 - a drift guard `src/lib/schemas/redactedArtifact.ts`'s own doc comment
 * had no test for: it claims to mirror `dogtag.redacted-tag-artifact.v1.schema.json`
 * "field-for-field", and that was true on inspection, but nothing in the suite compared the two,
 * so the day the vendored registry schema gains a required field or tightens a pattern, this
 * zod mirror would silently diverge with no test going red.
 *
 * This file loads the REAL vendored registry schema, compiles it with `ajv/dist/2020` (the same
 * setup `protocol/packages/dogtag-standard-ts/test/redacted_artifact_schema.test.ts` already uses
 * for its own, differently-scoped bidirectional check against `verifyRedactedArtifact`), and
 * asserts the zod mirror agrees with it on every one of this repo's two vendored fixture sets:
 * `specs/leaf-commitment-vectors.json`'s 11 curated `redactedArtifactVectors` and
 * `packages/dogtag-standard-ts/testvectors.json`'s 15 shared `redactedArtifacts` - not a
 * hand-picked handful, the full sweep, so a real registry-schema change against a real fixture
 * trips this test rather than a synthetic one that happens not to exercise the drift.
 *
 * Deliberately NOT re-testing `verifyRedactedArtifact` here (that bidirectional proof already
 * lives in the vendored package's own test, and vitest.config.ts's own doc comment explains why
 * that suite is not re-run from this app). This file only compares the two SHAPE layers - zod vs.
 * ajv - exactly the pair with no guard before this.
 */

const PROTOCOL_ROOT = resolve(__dirname, "..", "..", "..", "protocol");
const SCHEMA_PATH = resolve(PROTOCOL_ROOT, "specs", "schemas", "dogtag.redacted-tag-artifact.v1.schema.json");
const CURATED_VECTORS_PATH = resolve(PROTOCOL_ROOT, "specs", "leaf-commitment-vectors.json");
const SHARED_VECTORS_PATH = resolve(PROTOCOL_ROOT, "packages", "dogtag-standard-ts", "testvectors.json");

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({strict: true, allErrors: true});
ajv.addKeyword({keyword: "version"});
ajv.addKeyword({keyword: "x-validationRules"});
const ajvValidate = ajv.compile(schema);

interface WireLeaf {
  keyPath: string;
  saltHex: string;
  tag: number;
  value: string;
}
interface BaseVector {
  name: string;
  disclosed: WireLeaf[];
  obfuscatedLeafHashes: string[];
  reservedLeafHashes: string[];
  valid: boolean;
}
interface CuratedVector extends BaseVector {
  root_hex: string;
}
interface SharedVector extends BaseVector {
  root: string;
}

const curatedFile = JSON.parse(readFileSync(CURATED_VECTORS_PATH, "utf8")) as {redactedArtifactVectors: CuratedVector[]};
const sharedFile = JSON.parse(readFileSync(SHARED_VECTORS_PATH, "utf8")) as {redactedArtifacts: SharedVector[]};
const curatedVectors = curatedFile.redactedArtifactVectors;
const sharedVectors = sharedFile.redactedArtifacts;

// Guards a fixture file silently shrinking (and this sweep silently covering less than it claims
// to) - the same discipline the vendored precedent's own `negativeCases.length` pin applies.
it("pins the two vendored fixture-file counts this sweep claims to cover", () => {
  expect(curatedVectors.length).toBe(11);
  expect(sharedVectors.length).toBe(15);
});

/** A full RedactedTagArtifact-shaped envelope around one fixture's disclosed/obfuscated/reserved
 * triple - both the zod schema and the registry schema require `protocolVersion`/`dogTagIdField`/
 * `issuerClone` too, which the fixture files (whose OWN purpose is the leaf-commitment layer, not
 * the wire envelope) do not carry. Fixed, individually-valid dummy values for all three, mirroring
 * the vendored precedent's own `envelopeOf` - a real decimal string (not e.g. "1", which both
 * schemas' `decimalString`/`dogTagIdField` patterns accept fine, but using the same non-trivial
 * value the precedent test pins makes a copy-paste diff against it easy to eyeball). */
function envelopeOf(root: string, v: BaseVector): Record<string, unknown> {
  return {
    protocolVersion: "dogtag-v2/1",
    dogTagIdField: "19282080935305080861096842252900215298393603684181619512414474199363734335896",
    root,
    disclosed: v.disclosed,
    obfuscatedLeafHashes: v.obfuscatedLeafHashes,
    reservedLeafHashes: v.reservedLeafHashes,
    issuerClone: "0x" + "11".repeat(20),
  };
}

function agrees(artifact: Record<string, unknown>): {zod: boolean; ajv: boolean} {
  return {
    zod: redactedTagArtifactSchema.safeParse(artifact).success,
    ajv: ajvValidate(artifact) as boolean,
  };
}

describe("redactedTagArtifactSchema (zod) vs. dogtag.redacted-tag-artifact.v1.schema.json (ajv 2020-12) - shape agreement", () => {
  describe("11 curated vectors (specs/leaf-commitment-vectors.json's redactedArtifactVectors)", () => {
    for (const v of curatedVectors) {
      it(`${v.name} (disclosed.length=${v.disclosed.length}, obfuscatedLeafHashes.length=${v.obfuscatedLeafHashes.length}, reservedLeafHashes.length=${v.reservedLeafHashes.length})`, () => {
        const artifact = envelopeOf(v.root_hex, v);
        const result = agrees(artifact);
        expect(result.zod, `zod=${result.zod} ajv=${result.ajv} - the two schemas disagree on ${v.name}`).toBe(result.ajv);
      });
    }
  });

  describe("15 shared vectors (packages/dogtag-standard-ts/testvectors.json's redactedArtifacts)", () => {
    for (const v of sharedVectors) {
      it(`${v.name} (disclosed.length=${v.disclosed.length}, obfuscatedLeafHashes.length=${v.obfuscatedLeafHashes.length}, reservedLeafHashes.length=${v.reservedLeafHashes.length})`, () => {
        const artifact = envelopeOf(v.root, v);
        const result = agrees(artifact);
        expect(result.zod, `zod=${result.zod} ajv=${result.ajv} - the two schemas disagree on ${v.name}`).toBe(result.ajv);
      });
    }
  });

  // Absolute pins, not just equality - an agreement check alone would pass vacuously if a bad
  // dummy protocolVersion/dogTagIdField/issuerClone made BOTH schemas reject every single vector
  // for the wrong reason. These four confirm the sweep is actually exercising real accept/reject
  // outcomes, on both a curated and a shared vector, in both directions.
  describe("absolute verdict pins (both schemas, not merely equal to each other)", () => {
    it("profile_tree_base_full_artifact (curated): accepted by BOTH schemas", () => {
      const v = curatedVectors.find((v) => v.name === "profile_tree_base_full_artifact")!;
      const result = agrees(envelopeOf(v.root_hex, v));
      expect(result).toEqual({zod: true, ajv: true});
    });

    it("full_artifact_nothing_obfuscated (shared): accepted by BOTH schemas", () => {
      const v = sharedVectors.find((v) => v.name === "full_artifact_nothing_obfuscated")!;
      const result = agrees(envelopeOf(v.root, v));
      expect(result).toEqual({zod: true, ajv: true});
    });

    it("masked_variant_fully_obfuscated (curated): a genuinely masked shape, accepted by BOTH schemas", () => {
      const v = curatedVectors.find((v) => v.name === "masked_variant_fully_obfuscated")!;
      expect(v.disclosed.length).toBe(0);
      expect(v.obfuscatedLeafHashes.length).toBeGreaterThan(0);
      const result = agrees(envelopeOf(v.root_hex, v));
      expect(result).toEqual({zod: true, ajv: true});
    });

    it("negative_reserved_relabeled_as_obfuscated (curated): only 2 reservedLeafHashes - rejected by BOTH schemas", () => {
      const v = curatedVectors.find((v) => v.name === "negative_reserved_relabeled_as_obfuscated")!;
      expect(v.reservedLeafHashes.length).toBe(2);
      const result = agrees(envelopeOf(v.root_hex, v));
      expect(result).toEqual({zod: false, ajv: false});
    });

    it("negative_two_reserved_hashes (shared): only 2 reservedLeafHashes - rejected by BOTH schemas", () => {
      const v = sharedVectors.find((v) => v.name === "negative_two_reserved_hashes")!;
      expect(v.reservedLeafHashes.length).toBe(2);
      const result = agrees(envelopeOf(v.root, v));
      expect(result).toEqual({zod: false, ajv: false});
    });

    it("negative_hex32_shape_obfuscated_missing_0x_prefix (shared): a bad hex32 - rejected by BOTH schemas", () => {
      const v = sharedVectors.find((v) => v.name === "negative_hex32_shape_obfuscated_missing_0x_prefix")!;
      const result = agrees(envelopeOf(v.root, v));
      expect(result).toEqual({zod: false, ajv: false});
    });
  });

  // Synthetic structural mutations the 26 real vectors never happen to exercise (every one of them
  // is a complete envelope, even when crypto-invalid) - a "missing required field" case in
  // particular. Same mutate-a-known-good-base idiom the vendored precedent's own `negativeCases`
  // uses, applied here to zod/ajv agreement rather than to ajv/verifyRedactedArtifact agreement.
  interface NegativeCase {
    name: string;
    mutate: (a: Record<string, unknown>) => void;
  }
  const negativeCases: NegativeCase[] = [
    {name: "top-level `root` missing entirely", mutate: (a) => delete a.root},
    {name: "top-level `disclosed` missing entirely", mutate: (a) => delete a.disclosed},
    {name: "top-level `reservedLeafHashes` missing entirely", mutate: (a) => delete a.reservedLeafHashes},
    {name: "top-level `issuerClone` missing entirely", mutate: (a) => delete a.issuerClone},
    {name: "an obfuscatedLeafHashes entry is not hex at all", mutate: (a) => (a.obfuscatedLeafHashes = ["not-a-hash"])},
    {name: "a disclosed leaf's tag is out of range (6)", mutate: (a) => ((a.disclosed as Record<string, unknown>[])[0]!.tag = 6)},
  ];

  it("pins the synthetic negative-case count (guards a case silently dropped)", () => {
    expect(negativeCases.length).toBe(6);
  });

  describe("synthetic structural breaks not covered by any real vector: rejected by BOTH schemas", () => {
    for (const nc of negativeCases) {
      it(nc.name, () => {
        const base = curatedVectors.find((v) => v.name === "profile_tree_base_full_artifact")!;
        const broken = JSON.parse(JSON.stringify(envelopeOf(base.root_hex, base))) as Record<string, unknown>;
        nc.mutate(broken);
        const result = agrees(broken);
        expect(result).toEqual({zod: false, ajv: false});
      });
    }
  });
});
