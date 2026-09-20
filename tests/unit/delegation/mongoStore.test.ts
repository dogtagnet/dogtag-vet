import {afterEach, describe, expect, it, vi} from "vitest";
import {DelegationSession} from "@/lib/models/DelegationSession";
import {mongoDelegationStore} from "@/lib/delegation/mongoStore";

/**
 * `hasActiveSecondaryForClient` is the one non-mechanical query in this store - a two-query
 * set-difference (confirmed adds for this client, minus any commitment among them that a
 * confirmed revoke has since removed) that no single Mongo filter expresses directly. Mocked
 * `DelegationSession.find` so this can assert the SUBTRACTION logic itself deterministically,
 * without a live database - mirrors `tests/unit/registration/mongoStore.test.ts`'s own
 * mocked-mongoose convention.
 */
function mockFind(sequence: {commitment?: string}[][]) {
  let call = 0;
  return vi.spyOn(DelegationSession, "find").mockImplementation(() => {
    const result = sequence[call] ?? [];
    call += 1;
    return {select: () => ({lean: () => Promise.resolve(result)})} as never;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mongoDelegationStore.hasActiveSecondaryForClient", () => {
  it("true when the client has a confirmed add with no matching confirmed revoke", async () => {
    mockFind([[{commitment: "0xaaaa"}], []]); // adds, then revokes
    const result = await mongoDelegationStore.hasActiveSecondaryForClient("42", "client-1");
    expect(result).toBe(true);
  });

  it("false once every one of the client's added commitments has since been revoked", async () => {
    mockFind([[{commitment: "0xaaaa"}], [{commitment: "0xaaaa"}]]);
    const result = await mongoDelegationStore.hasActiveSecondaryForClient("42", "client-1");
    expect(result).toBe(false);
  });

  it("false when the client has never added anything", async () => {
    mockFind([[], [{commitment: "0xbbbb"}]]);
    const result = await mongoDelegationStore.hasActiveSecondaryForClient("42", "client-1");
    expect(result).toBe(false);
  });

  it("a revoke of a DIFFERENT commitment does not clear this client's own still-active one", async () => {
    mockFind([[{commitment: "0xaaaa"}], [{commitment: "0xbbbb"}]]);
    const result = await mongoDelegationStore.hasActiveSecondaryForClient("42", "client-1");
    expect(result).toBe(true);
  });
});
