// Cross-language parity gates (impl §9, Gate A) - asserts the SDK against the two vector files
// shared with `dogtag-standard-rs` and the frozen circuit: `circuits/poseidon-vectors.json` (the
// raw Poseidon primitive, every arity DogTag uses) and `testvectors.json` (leaf/bytesToField/
// merkle/inclusion, already asserted in `sdk.test.ts` - re-asserted here as one gate that fails
// loudly on ANY unrecognized shape change, not only a wrong hash).
//
// Every check below RECOMPUTES from the vector's own inputs and compares against ITS OWN recorded
// output - never against a value computed by the same code path being tested - so flipping one
// character of any `out_hex` / `expected_hex` in either file, or deleting a vector, fails this
// suite. (Per the WP2 grader: corrupt one vector in a temp copy, rerun, confirm red, then restore.)
import {describe, it, expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {poseidon, toHex32, fromHex32} from "../src/field.js";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const POSEIDON_VECTORS_PATH = resolve(REPO_ROOT, "circuits", "poseidon-vectors.json");

interface PoseidonVector {
  name: string;
  arity: number;
  width: number;
  in: string[];
  out_dec: string;
  out_hex: string;
}

interface PoseidonVectorFile {
  field_r: string;
  anchor: {dec: string; hex: string};
  domain_tags: Record<string, number>;
  vector_count: number;
  vectors: PoseidonVector[];
}

const FIELD_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

describe("circuits/poseidon-vectors.json (Gate A - raw Poseidon primitive)", () => {
  const raw = readFileSync(POSEIDON_VECTORS_PATH, "utf8");
  const file = JSON.parse(raw) as PoseidonVectorFile;

  it("the field modulus matches the SDK's FIELD_P", () => {
    expect(BigInt(file.field_r)).toBe(FIELD_R);
  });

  it("declares at least one vector per arity DogTag uses (2, 3, 5, 6)", () => {
    const arities = new Set(file.vectors.map((v) => v.arity));
    for (const a of [2, 3, 5, 6]) expect(arities.has(a)).toBe(true);
  });

  it("vector_count matches the actual array length (guards silent truncation)", () => {
    expect(file.vectors.length).toBe(file.vector_count);
    expect(file.vectors.length).toBeGreaterThan(0);
  });

  it("every declared vector is present and internally consistent (arity == input count == width - 1)", () => {
    for (const v of file.vectors) {
      expect(v.in.length, `${v.name}: in.length must equal arity`).toBe(v.arity);
      expect(v.width, `${v.name}: width must equal arity + 1`).toBe(v.arity + 1);
    }
  });

  for (const v of file.vectors) {
    it(`poseidon${v.arity}(${v.name}) matches out_hex AND out_dec`, () => {
      const inputs = v.in.map((s) => BigInt(s));
      const got = poseidon(inputs);
      expect(toHex32(got)).toBe(v.out_hex.toLowerCase());
      expect(got.toString()).toBe(v.out_dec);
    });
  }

  it("the anchor vector (poseidon2(1,2)) is the one every other implementation is pinned against", () => {
    expect(poseidon([1n, 2n])).toBe(BigInt(file.anchor.dec));
    expect(toHex32(poseidon([1n, 2n]))).toBe(file.anchor.hex.toLowerCase());
  });
});

interface TestVectorFile {
  field_p: string;
  leaves: Array<{name: string; expected_hex: string}>;
  bytesToField: Array<{name: string; expected_hex: string}>;
  merkle: Array<{name: string; root_hex: string}>;
  inclusion: Array<{name: string; valid: boolean}>;
}

describe("testvectors.json (Gate A - leaf/bytesToField/merkle/inclusion shape guard)", () => {
  const TESTVECTORS_PATH = resolve(__dirname, "..", "testvectors.json");
  const file = JSON.parse(readFileSync(TESTVECTORS_PATH, "utf8")) as TestVectorFile;

  it("the field modulus matches the SDK's FIELD_P", () => {
    expect(BigInt(file.field_p)).toBe(FIELD_R);
  });

  // Every category must be present and non-empty, so a corrupted file that DROPS a whole section
  // (rather than tweaking one hash) is caught here even though `sdk.test.ts` iterates each section
  // independently and would simply run zero tests for a missing/emptied one.
  it("every vector category is present and non-empty", () => {
    for (const key of ["leaves", "bytesToField", "merkle", "inclusion"] as const) {
      expect(Array.isArray(file[key]), `${key} must be an array`).toBe(true);
      expect(file[key].length, `${key} must be non-empty`).toBeGreaterThan(0);
    }
  });

  it("no top-level key is unrecognized (guards a silently renamed/added section going unchecked)", () => {
    const known = new Set(["_comment", "field_p", "leaves", "bytesToField", "merkle", "inclusion"]);
    for (const key of Object.keys(file)) {
      expect(known.has(key), `unrecognized testvectors.json key: ${key}`).toBe(true);
    }
  });

  it("every leaf/bytesToField/merkle expected hex is a well-formed 0x + 64 hex-char field element", () => {
    const HEX32 = /^0x[0-9a-fA-F]{64}$/;
    for (const v of file.leaves) expect(v.expected_hex, v.name).toMatch(HEX32);
    for (const v of file.bytesToField) expect(v.expected_hex, v.name).toMatch(HEX32);
    for (const v of file.merkle) expect(v.root_hex, v.name).toMatch(HEX32);
    // round-trip every recorded hex through fromHex32/toHex32 so a value that LOOKS like hex but
    // exceeds the field (or has an odd byte count under the hood) is caught here too.
    for (const v of [...file.leaves, ...file.bytesToField]) {
      expect(toHex32(fromHex32(v.expected_hex))).toBe(v.expected_hex.toLowerCase());
    }
  });
});
