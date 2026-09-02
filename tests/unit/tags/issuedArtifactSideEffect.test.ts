import {describe, expect, it, vi} from "vitest";
import {TypeTag, type OpenedLeaf} from "@dogtag/standard";
import {
  applyIssuedArtifactSideEffect,
  type ApplyIssuedArtifactSideEffectInput,
  type IssuedArtifactSideEffectStore,
} from "@/lib/tags/issuedArtifactSideEffect";

/**
 * WP4.9 checklist item 3a - the custodial-bind terminal write's TagArtifact side effect. Exercised
 * against an in-memory fake store (the same "flow/store-adapter" testability pattern as
 * `lib/booking/postBooking.ts`'s own test file), never a real database - `createTagArtifact`'s own
 * invariant is already covered by `tests/unit/models/tagArtifact.integration.test.ts` against a
 * real ephemeral mongod; this file only tests the SIDE-EFFECT CONTRACT (never throws, flags on
 * failure, best-effort flag write).
 */

const LEAVES: OpenedLeaf[] = [{keyPath: "credentialSubject.species", saltHex: `0x${"aa".repeat(16)}`, tag: TypeTag.String, value: "dog"}];
const RESERVED = [`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`, `0x${"3".repeat(64)}`];

function baseInput(overrides: Partial<ApplyIssuedArtifactSideEffectInput> = {}): ApplyIssuedArtifactSideEffectInput {
  return {
    sessionId: "session-1",
    petId: "pet-1",
    dogTagIdDec: "42",
    dogTagIdField: "123456",
    root: `0x${"ab".repeat(32)}`,
    leaves: LEAVES,
    reservedLeafHashes: RESERVED,
    identityLeaves: [],
    issuerClone: "0xClone",
    now: 1_700_000_000,
    ...overrides,
  };
}

function fakeStore(overrides: Partial<IssuedArtifactSideEffectStore> = {}): IssuedArtifactSideEffectStore & {flagged: string[]} {
  const flagged: string[] = [];
  return {
    flagged,
    createTagArtifact: vi.fn().mockResolvedValue({ok: true, artifact: {} as never, reactivated: false}),
    async flagArtifactError(sessionId) {
      flagged.push(sessionId);
    },
    ...overrides,
  };
}

describe("applyIssuedArtifactSideEffect", () => {
  it("on success, calls createTagArtifact with the exact fields and never flags", async () => {
    const store = fakeStore();
    const result = await applyIssuedArtifactSideEffect(store, baseInput());
    expect(result).toEqual({completed: true});
    expect(store.createTagArtifact).toHaveBeenCalledWith({
      petId: "pet-1",
      dogTagIdDec: "42",
      dogTagIdField: "123456",
      root: `0x${"ab".repeat(32)}`,
      leaves: LEAVES,
      reservedLeafHashes: RESERVED,
      expectedIdentityLeaves: [],
      issuerClone: "0xClone",
      now: 1_700_000_000,
    });
    expect(store.flagged).toEqual([]);
  });

  it("defensive: missing petId is caught and flagged, never thrown", async () => {
    const store = fakeStore();
    const result = await applyIssuedArtifactSideEffect(store, baseInput({petId: undefined}));
    expect(result).toEqual({completed: false});
    expect(store.createTagArtifact).not.toHaveBeenCalled();
    expect(store.flagged).toEqual(["session-1"]);
  });

  it("defensive: missing issuerClone is caught and flagged, never thrown", async () => {
    const store = fakeStore();
    const result = await applyIssuedArtifactSideEffect(store, baseInput({issuerClone: undefined}));
    expect(result).toEqual({completed: false});
    expect(store.createTagArtifact).not.toHaveBeenCalled();
    expect(store.flagged).toEqual(["session-1"]);
  });

  it("createTagArtifact refusing (e.g. leaf_commitment_invalid) is caught and flagged, never thrown", async () => {
    const store = fakeStore({createTagArtifact: vi.fn().mockResolvedValue({ok: false, reason: "leaf_commitment_invalid"})});
    const result = await applyIssuedArtifactSideEffect(store, baseInput());
    expect(result).toEqual({completed: false});
    expect(store.flagged).toEqual(["session-1"]);
  });

  it("createTagArtifact throwing (e.g. a transient DB error) is caught and flagged, never thrown", async () => {
    const store = fakeStore({createTagArtifact: vi.fn().mockRejectedValue(new Error("connection reset"))});
    const result = await applyIssuedArtifactSideEffect(store, baseInput());
    expect(result).toEqual({completed: false});
    expect(store.flagged).toEqual(["session-1"]);
  });

  it("even the flag write itself failing is swallowed - the caller never sees a throw", async () => {
    const store = fakeStore({
      createTagArtifact: vi.fn().mockRejectedValue(new Error("connection reset")),
      flagArtifactError: vi.fn().mockRejectedValue(new Error("flag write also failed")),
    });
    await expect(applyIssuedArtifactSideEffect(store, baseInput())).resolves.toEqual({completed: false});
  });
});
