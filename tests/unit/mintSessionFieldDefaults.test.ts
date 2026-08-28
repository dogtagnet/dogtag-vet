import {describe, expect, it} from "vitest";
import {toSessionRow} from "@/lib/mint/mongoStore";
import type {MintSessionDoc} from "@/lib/models/MintSession";

/**
 * Regression for the round-3 grader finding: `GET /p/:token` threw `Cannot read properties of
 * undefined (reading 'code')` for any mint session with no microchip data - the ordinary case,
 * since `microchip` is `.optional()` in `startMintSessionSchema` and the start route writes
 * `microchip: input.microchip ?? {}`.
 *
 * The empty `{}` never actually reaches MongoDB: mongoose's `minimize` option (on by default)
 * strips empty subdocuments before the write, for BOTH `MintSession.microchip` and (confirmed by
 * the same check against a live mongod during triage) `Pet.microchip` - so a `.lean()` read comes
 * back with the `microchip` key entirely absent, not `{}`, regardless of the schema-level default.
 * The same triage against a live mongod found `ownerIdentity` has the identical problem: it is
 * three bare, default-less `String` paths, so a session with no owner-identity data has that whole
 * path stripped too - `profile` alone survives, kept alive by `weightHistory`'s array default.
 * `MintSessionResolveResponse` in vet-public-api.yaml marks `ownerIdentity` required on every
 * resolve response, so a dropped key there is a wire-contract violation, not just an omission.
 *
 * The fix that actually closes both gaps is at the read boundary in `mongoStore.ts`'s
 * `toSessionRow`, which now defaults a missing `microchip` and `ownerIdentity` to `{}` on the way
 * out of the store - the schema-level `default: () => ({})` alone (present on both fields) is not
 * sufficient, since minimize strips the default's own output right back out before persisting.
 * These tests drive `toSessionRow` directly with exactly the shape a minimized document produces -
 * the field missing entirely, not `{}` - and assert both the resolved row and the resolve route's
 * exact field-access expression survive.
 */
describe("toSessionRow field fallbacks", () => {
  it("defaults a missing microchip to {} so GET /p/:token's field access never throws", () => {
    const legacyDoc = {
      sessionId: "session-1",
      dogTagIdDec: "1043",
      dogTagIdField: "0x1",
      ownerIdentity: {},
      identityLeaves: [],
      petName: "Fido",
      profile: {weightHistory: []},
      status: "pending",
    } as unknown as MintSessionDoc; // no `microchip` key - what minimize actually persists

    const row = toSessionRow(legacyDoc);
    expect(row.microchip).toEqual({});

    // The exact expression `GET /p/:token` (src/app/p/[token]/route.ts) evaluates on the resolved
    // session's microchip field.
    expect(() => ({
      code: row.microchip.code,
      standard: row.microchip.standard,
      implantDate: row.microchip.implantDate,
      bodyLocation: row.microchip.bodyLocation,
    })).not.toThrow();
  });

  it("passes through a populated microchip unchanged", () => {
    const doc = {
      sessionId: "session-2",
      dogTagIdDec: "1044",
      dogTagIdField: "0x2",
      ownerIdentity: {},
      identityLeaves: [],
      petName: "Rex",
      microchip: {code: "985121000000000", standard: "ISO11784"},
      profile: {weightHistory: []},
      status: "pending",
    } as unknown as MintSessionDoc;

    const row = toSessionRow(doc);
    expect(row.microchip).toEqual({code: "985121000000000", standard: "ISO11784"});
  });

  it("defaults a missing ownerIdentity to {} - vet-public-api.yaml requires the key on every resolve response", () => {
    const legacyDoc = {
      sessionId: "session-3",
      dogTagIdDec: "1045",
      dogTagIdField: "0x3",
      identityLeaves: [],
      petName: "Fido",
      profile: {weightHistory: []},
      status: "pending",
    } as unknown as MintSessionDoc; // no `ownerIdentity` key - what minimize actually persists

    const row = toSessionRow(legacyDoc);
    expect(row.ownerIdentity).toEqual({});
  });
});
