import {describe, expect, it} from "vitest";
import {toPlain} from "@/lib/toPlain";

/** Stand-in for bson's ObjectId: an object with a `toJSON` method and a buffer, which is exactly
 * what Next.js rejects at the RSC boundary. */
class FakeObjectId {
  buffer = new Uint8Array([1, 2, 3]);
  toJSON() {
    return "abc123";
  }
}

describe("toPlain", () => {
  it("drops _id and __v at the top level", () => {
    const doc = {_id: new FakeObjectId(), __v: 0, petId: "p-1", name: "Blaze"};
    expect(toPlain(doc)).toEqual({petId: "p-1", name: "Blaze"});
  });

  it("drops _id/__v recursively - nested subdocuments and array entries", () => {
    const doc = {
      _id: new FakeObjectId(),
      dogTag: {_id: new FakeObjectId(), root: "0xabc"},
      weightHistory: [{_id: new FakeObjectId(), value: "12.5"}],
    };
    expect(toPlain(doc)).toEqual({dogTag: {root: "0xabc"}, weightHistory: [{value: "12.5"}]});
  });

  it("preserves Date instances untouched (RSC serializes them natively)", () => {
    const createdAt = new Date("2026-09-01T00:00:00Z");
    const out = toPlain({createdAt, nested: {when: createdAt}});
    expect(out.createdAt).toBe(createdAt);
    expect(out.nested.when).toBe(createdAt);
  });

  it("passes through primitives, null, undefined, and arrays of primitives", () => {
    expect(toPlain(null)).toBeNull();
    expect(toPlain(undefined)).toBeUndefined();
    expect(toPlain("x")).toBe("x");
    expect(toPlain(42)).toBe(42);
    expect(toPlain(["a", "b"])).toEqual(["a", "b"]);
  });

  it("leaves ordinary nested data intact", () => {
    const doc = {a: {b: {c: [1, {d: "e"}]}}, ok: true};
    expect(toPlain(doc)).toEqual(doc);
  });
});
