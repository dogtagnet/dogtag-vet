import {describe, expect, it} from "vitest";
import {reconcileDelegationWrite, type DelegationReconcileDeps} from "@/lib/delegation/reconcile";

function makeDeps(overrides: Partial<DelegationReconcileDeps> = {}): DelegationReconcileDeps {
  return {
    isSecondary: async () => false,
    secondaryCount: async () => 0,
    delegationRoot: async () => "0xroot",
    txReceiptStatus: async () => "success",
    ...overrides,
  };
}

describe("reconcileDelegationWrite", () => {
  it("add: reconciled once isSecondary reports true, recording the audit-trail values", async () => {
    const deps = makeDeps({isSecondary: async () => true, secondaryCount: async () => 4, delegationRoot: async () => "0xroot4"});
    const result = await reconcileDelegationWrite({kind: "add", dogTagIdField: "42", commitment: "0xaa", txHash: "0xtx"}, deps);
    expect(result).toEqual({reconciled: true, secondaryCount: 4, delegationRoot: "0xroot4"});
  });

  it("revoke: reconciled once isSecondary reports false (the opposite postcondition of add)", async () => {
    const deps = makeDeps({isSecondary: async () => false});
    const result = await reconcileDelegationWrite({kind: "revoke", dogTagIdField: "42", commitment: "0xaa", txHash: "0xtx"}, deps);
    expect(result.reconciled).toBe(true);
  });

  it("a confirmed revert is conclusive, even if isSecondary would otherwise look right", async () => {
    const deps = makeDeps({txReceiptStatus: async () => "reverted", isSecondary: async () => true});
    const result = await reconcileDelegationWrite({kind: "add", dogTagIdField: "42", commitment: "0xaa", txHash: "0xtx"}, deps);
    expect(result).toEqual({reconciled: false, reason: "reverted", txHash: "0xtx"});
  });

  it("not-yet when the postcondition has not landed and nothing is provably reverted", async () => {
    const deps = makeDeps({isSecondary: async () => false}); // add expects true
    const result = await reconcileDelegationWrite({kind: "add", dogTagIdField: "42", commitment: "0xaa", txHash: "0xtx"}, deps);
    expect(result).toEqual({reconciled: false, reason: "not-yet"});
  });

  it("a concurrent unrelated write moving secondaryCount/delegationRoot does not itself cause a false refusal - isSecondary alone decides", async () => {
    // secondaryCount/delegationRoot both moved for reasons unrelated to this session's own
    // commitment (another clinic's own add/revoke), but isSecondary(THIS commitment) is correct.
    const deps = makeDeps({isSecondary: async () => true, secondaryCount: async () => 7, delegationRoot: async () => "0xsurprising"});
    const result = await reconcileDelegationWrite({kind: "add", dogTagIdField: "42", commitment: "0xaa", txHash: "0xtx"}, deps);
    expect(result.reconciled).toBe(true);
  });

  it("chain-read-failed when the receipt read itself throws", async () => {
    const deps = makeDeps({
      txReceiptStatus: async () => {
        throw new Error("rpc down");
      },
    });
    const result = await reconcileDelegationWrite({kind: "add", dogTagIdField: "42", commitment: "0xaa", txHash: "0xtx"}, deps);
    expect(result).toEqual({reconciled: false, reason: "chain-read-failed"});
  });

  it("chain-read-failed when the isSecondary/count/root reads throw", async () => {
    const deps = makeDeps({
      isSecondary: async () => {
        throw new Error("rpc down");
      },
    });
    const result = await reconcileDelegationWrite({kind: "add", dogTagIdField: "42", commitment: "0xaa", txHash: "0xtx"}, deps);
    expect(result).toEqual({reconciled: false, reason: "chain-read-failed"});
  });

  it("no txHash yet (boot-recovery style call) still runs the isSecondary check directly", async () => {
    const deps = makeDeps({isSecondary: async () => true, secondaryCount: async () => 1, delegationRoot: async () => "0xr"});
    const result = await reconcileDelegationWrite({kind: "add", dogTagIdField: "42", commitment: "0xaa"}, deps);
    expect(result).toEqual({reconciled: true, secondaryCount: 1, delegationRoot: "0xr"});
  });
});
