import {describe, expect, it} from "vitest";
import {buildMerkle, toHex32, type Field} from "@dogtag/standard";
import {DELEGATION_TREE_SIZE, EMPTY_DELEGATION_ROOT} from "@/lib/delegation/constants";

/**
 * `EMPTY_DELEGATION_ROOT` is a pinned literal (see `constants.ts`'s own doc comment) - this test
 * is the derivation, so the pin can never silently drift from what the vendored crypto actually
 * produces. Mirrors `docs/DELEGATION.md` section 4.2's own probe (`buildMerkle` over sixteen zero
 * leaves), against the SAME vendored `@dogtag/standard` package this app already depends on,
 * rather than a second hand-rolled Poseidon implementation.
 */
describe("EMPTY_DELEGATION_ROOT", () => {
  it("equals buildMerkle's fold of sixteen zero leaves via the vendored @dogtag/standard", () => {
    const leaves: Field[] = Array.from({length: DELEGATION_TREE_SIZE}, () => 0n);
    const {root} = buildMerkle(leaves);
    expect(toHex32(root)).toBe(EMPTY_DELEGATION_ROOT);
  });

  it("is NOT the same as a bare zero hash - a reader must never compare a root against 0", () => {
    expect(EMPTY_DELEGATION_ROOT).not.toBe(`0x${"0".repeat(64)}`);
  });
});
