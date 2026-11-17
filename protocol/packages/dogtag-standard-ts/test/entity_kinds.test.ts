// Unit tests for src/entityKinds.ts (specs/entity-kinds.md).
import {describe, it, expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {
  ENTITY_KINDS,
  ENTITY_KIND_IDS,
  entityKindsFromMask,
  maskFromEntityKinds,
  primaryEntityKind,
  type EntityKindId,
} from "../src/index.js";

const SPEC_PATH = resolve(__dirname, "..", "..", "..", "specs", "entity-kinds.json");

describe("entity kinds registry", () => {
  it("matches specs/entity-kinds.json exactly", () => {
    const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
    expect(spec.version).toBe(1);
    expect(spec.reservedBits).toEqual([0]);
    expect(ENTITY_KINDS.map((k) => ({bit: k.bit, id: k.id, label: k.label}))).toEqual(spec.kinds);
    expect([...ENTITY_KIND_IDS]).toEqual(spec.kinds.map((k: {id: string}) => k.id));
  });

  it("bit numbers are 1 to 5 in order and bit 0 is not a kind", () => {
    expect(ENTITY_KINDS.map((k) => k.bit)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("entityKindsFromMask", () => {
  it("returns kinds in bit order", () => {
    expect(entityKindsFromMask(2n)).toEqual(["VET"]);
    expect(entityKindsFromMask(4n)).toEqual(["GOVERNMENT"]);
    expect(entityKindsFromMask(8n)).toEqual(["GROOMER"]);
    expect(entityKindsFromMask(16n)).toEqual(["BOARDING"]);
    expect(entityKindsFromMask(32n)).toEqual(["DAYCARE"]);
    expect(entityKindsFromMask(10n)).toEqual(["VET", "GROOMER"]);
    expect(entityKindsFromMask(62n)).toEqual(["VET", "GOVERNMENT", "GROOMER", "BOARDING", "DAYCARE"]);
  });

  it("drops unknown bits, bit 0 included, and never throws on them", () => {
    expect(entityKindsFromMask(0n)).toEqual([]);
    expect(entityKindsFromMask(1n)).toEqual([]);
    expect(entityKindsFromMask(1n << 6n)).toEqual([]);
    expect(entityKindsFromMask(1n << 255n)).toEqual([]);
    expect(entityKindsFromMask(2n | (1n << 6n) | (1n << 200n))).toEqual(["VET"]);
    expect(entityKindsFromMask((1n << 256n) - 1n)).toEqual(["VET", "GOVERNMENT", "GROOMER", "BOARDING", "DAYCARE"]);
  });

  it("rejects values that are not a uint256", () => {
    expect(() => entityKindsFromMask(-1n)).toThrow(RangeError);
    expect(() => entityKindsFromMask(1n << 256n)).toThrow(RangeError);
    expect(() => entityKindsFromMask(2 as unknown as bigint)).toThrow(TypeError);
  });
});

describe("maskFromEntityKinds", () => {
  it("round trips every non-empty subset of the five kinds", () => {
    for (let subset = 1; subset < 32; subset++) {
      const ids = ENTITY_KIND_IDS.filter((_, i) => (subset >> i) & 1);
      const mask = maskFromEntityKinds(ids);
      expect(entityKindsFromMask(mask)).toEqual(ids);
      expect(mask).toBe(BigInt(subset) << 1n);
    }
  });

  it("does not depend on input order", () => {
    expect(maskFromEntityKinds(["GROOMER", "VET"])).toBe(10n);
    expect(maskFromEntityKinds(["VET", "GROOMER"])).toBe(10n);
  });

  it("never sets bit 0", () => {
    for (const id of ENTITY_KIND_IDS) expect(maskFromEntityKinds([id]) & 1n).toBe(0n);
  });

  it("throws on an empty list", () => {
    expect(() => maskFromEntityKinds([])).toThrow(/empty/);
  });

  it("throws on an unknown id, case sensitively", () => {
    expect(() => maskFromEntityKinds(["KENNEL" as EntityKindId])).toThrow(/unknown/);
    expect(() => maskFromEntityKinds(["vet" as EntityKindId])).toThrow(/unknown/);
    expect(() => maskFromEntityKinds(["VET", "BIRD" as EntityKindId])).toThrow(/unknown/);
  });

  it("throws on a duplicate id", () => {
    expect(() => maskFromEntityKinds(["VET", "VET"])).toThrow(/duplicate/);
    expect(() => maskFromEntityKinds(["VET", "GROOMER", "VET"])).toThrow(/duplicate/);
  });
});

describe("primaryEntityKind", () => {
  it("is the lowest set known bit", () => {
    expect(primaryEntityKind(10n)).toBe("VET");
    expect(primaryEntityKind(24n)).toBe("GROOMER");
    expect(primaryEntityKind(48n)).toBe("BOARDING");
    expect(primaryEntityKind(32n)).toBe("DAYCARE");
    expect(primaryEntityKind(62n)).toBe("VET");
  });

  it("skips unknown bits and is null when no set bit is known", () => {
    expect(primaryEntityKind(0n)).toBeNull();
    expect(primaryEntityKind(1n)).toBeNull();
    expect(primaryEntityKind(1n << 6n)).toBeNull();
    expect(primaryEntityKind(8n | (1n << 9n))).toBe("GROOMER");
    expect(primaryEntityKind(1n | 32n)).toBe("DAYCARE");
  });
});
