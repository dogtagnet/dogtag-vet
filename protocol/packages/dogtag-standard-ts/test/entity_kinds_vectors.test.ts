// Conformance gate for specs/entity-kinds-vectors.json. Everything here is HAND-WRITTEN and independent of
// src/entityKinds.ts and of the generator: the kind table comes straight from specs/entity-kinds.json,
// the bit logic is re-done with plain bigint shifts, and a set of expectations is spelled out as literals
// so a bug shared by the generator and the helper cannot pass unnoticed.
import {describe, it, expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";

const SPECS = resolve(__dirname, "..", "..", "..", "specs");
const registry = JSON.parse(readFileSync(resolve(SPECS, "entity-kinds.json"), "utf8")) as {
  reservedBits: number[];
  kinds: {bit: number; id: string; label: string}[];
};
const vectors = JSON.parse(readFileSync(resolve(SPECS, "entity-kinds-vectors.json"), "utf8")) as {
  registryVersion: number;
  fromMask: {name: string; mask: string; kinds: string[]; primary: string | null}[];
  fromIds: {name: string; kinds: string[]; mask: string}[];
  fromIdsErrors: {name: string; kinds: string[]; error: string}[];
};

// Independent reference model, straight from the spec rules.
function knownKinds(mask: bigint): string[] {
  const sorted = [...registry.kinds].sort((a, b) => a.bit - b.bit);
  const out: string[] = [];
  for (const k of sorted) {
    if (((mask >> BigInt(k.bit)) & 1n) === 1n) out.push(k.id);
  }
  return out;
}
function maskFor(ids: string[]): bigint | "empty" | "unknown_id" | "duplicate" {
  if (ids.length === 0) return "empty";
  let m = 0n;
  const seen: string[] = [];
  for (const id of ids) {
    const k = registry.kinds.find((x) => x.id === id);
    if (!k) return "unknown_id";
    if (seen.includes(id)) return "duplicate";
    seen.push(id);
    m += 1n << BigInt(k.bit);
  }
  return m;
}

describe("specs/entity-kinds-vectors.json", () => {
  it("is built against registry version 1 and the spec reserves bit 0", () => {
    expect(vectors.registryVersion).toBe(1);
    expect(registry.reservedBits).toEqual([0]);
    expect(registry.kinds.map((k) => [k.bit, k.id])).toEqual([
      [1, "VET"],
      [2, "GOVERNMENT"],
      [3, "GROOMER"],
      [4, "BOARDING"],
      [5, "DAYCARE"],
    ]);
  });

  it("every fromMask vector matches the independent model", () => {
    expect(vectors.fromMask.length).toBeGreaterThanOrEqual(15);
    for (const v of vectors.fromMask) {
      expect(v.mask, v.name).toMatch(/^(0|[1-9][0-9]*)$/);
      const mask = BigInt(v.mask);
      expect(mask < 1n << 256n, v.name).toBe(true);
      const expected = knownKinds(mask);
      expect(v.kinds, v.name).toEqual(expected);
      expect(v.primary, v.name).toBe(expected[0] ?? null);
    }
  });

  it("every fromIds vector matches the independent model", () => {
    for (const v of vectors.fromIds) {
      expect(maskFor(v.kinds), v.name).toBe(BigInt(v.mask));
    }
  });

  it("every fromIdsErrors vector is rejected for the stated reason", () => {
    for (const v of vectors.fromIdsErrors) {
      expect(maskFor(v.kinds), v.name).toBe(v.error);
    }
  });

  it("holds the literal expectations spelled out by hand", () => {
    const byName = (n: string) => {
      const v = vectors.fromMask.find((x) => x.name === n);
      if (!v) throw new Error(`missing vector: ${n}`);
      return v;
    };
    expect(byName("zero mask")).toMatchObject({mask: "0", kinds: [], primary: null});
    expect(byName("vet only")).toMatchObject({mask: "2", kinds: ["VET"], primary: "VET"});
    expect(byName("daycare only")).toMatchObject({mask: "32", kinds: ["DAYCARE"], primary: "DAYCARE"});
    expect(byName("vet and groomer")).toMatchObject({mask: "10", kinds: ["VET", "GROOMER"], primary: "VET"});
    expect(byName("all five kinds")).toMatchObject({
      mask: "62",
      kinds: ["VET", "GOVERNMENT", "GROOMER", "BOARDING", "DAYCARE"],
      primary: "VET",
    });
    expect(byName("bit 0 only is dropped")).toMatchObject({mask: "1", kinds: [], primary: null});
    expect(byName("only bit 6 is unknown")).toMatchObject({mask: "64", kinds: [], primary: null});
    expect(byName("only bit 255 is unknown")).toMatchObject({
      mask: "57896044618658097711785492504343953926634992332820282019728792003956564819968",
      kinds: [],
      primary: null,
    });
    expect(byName("groomer with unknown bit 9, primary is the lowest known bit")).toMatchObject({
      mask: "520",
      kinds: ["GROOMER"],
      primary: "GROOMER",
    });
    expect(vectors.fromIds.find((v) => v.name === "vet and groomer")?.mask).toBe("10");
    expect(vectors.fromIds.find((v) => v.name === "order does not matter")?.mask).toBe("10");
    expect(vectors.fromIds.find((v) => v.name === "all five kinds")?.mask).toBe("62");
    expect(vectors.fromIdsErrors.map((v) => v.error).sort()).toEqual(
      ["duplicate", "duplicate", "empty", "unknown_id", "unknown_id"],
    );
  });
});
