import {describe, expect, it} from "vitest";
import {isMintSessionStale, reconcileAnchoredSession, type ReconcileDeps} from "@/lib/mint/reconcile";

const ROOT = "0xaaaa000000000000000000000000000000000000000000000000000000aa";
const OTHER_ROOT = "0xbbbb000000000000000000000000000000000000000000000000000000bb";
const CLONE_ADDRESS = "0x1111111111111111111111111111111111111111";

/** In-memory `ReconcileDeps` fake, matching `tests/unit/book.concurrency.test.ts` and
 * `tests/unit/mintFlow.integration.test.ts`'s convention of exercising the pure logic against a
 * hand-rolled store rather than a real database or RPC. `readTxReceiptStatus` defaults to
 * "pending" (never scripted a specific vector) - not "success" - so a test that forgets to set it
 * cannot accidentally look like it exercised the reverted-receipt short-circuit. */
function fakeDeps(
  overrides: Partial<ReconcileDeps> & {onChainRoot?: string; valid?: boolean} = {},
) {
  const boundSessionIds: string[] = [];
  const linkedPets: {petId: string; tag: unknown}[] = [];
  const revertedReady: {sessionId: string; txHash: string}[] = [];
  const readProfileRootCalls: string[] = [];
  const deps: ReconcileDeps = {
    readProfileRoot:
      overrides.readProfileRoot ??
      (async (dogTagIdFieldDec) => {
        readProfileRootCalls.push(dogTagIdFieldDec);
        return overrides.onChainRoot ?? ROOT;
      }),
    readIsValidRoot: overrides.readIsValidRoot ?? (async () => overrides.valid ?? true),
    readTxReceiptStatus: overrides.readTxReceiptStatus ?? (async () => "pending"),
    markSessionBound: overrides.markSessionBound ?? (async (sessionId) => void boundSessionIds.push(sessionId)),
    linkPetDogTag: overrides.linkPetDogTag ?? (async (petId, tag) => void linkedPets.push({petId, tag})),
    markSessionRevertedReady:
      overrides.markSessionRevertedReady ?? (async (sessionId, txHash) => void revertedReady.push({sessionId, txHash})),
  };
  return {deps, boundSessionIds, linkedPets, revertedReady, readProfileRootCalls};
}

describe("isMintSessionStale (the worker boot-recovery age guard)", () => {
  const now = 1_000_000_000;

  it("leaves a seconds-old in-flight issuance alone", () => {
    const session = {issuingAt: new Date(now - 10_000), createdAt: new Date(now - 10_000)};
    expect(isMintSessionStale(session, now, 5 * 60_000)).toBe(false);
  });

  it("flags a session that has been issuing for longer than the threshold", () => {
    const session = {issuingAt: new Date(now - 6 * 60_000), createdAt: new Date(now - 6 * 60_000)};
    expect(isMintSessionStale(session, now, 5 * 60_000)).toBe(true);
  });

  it("is not fooled by a long PENDING wait before a recent issuing transition", () => {
    // The bug the age guard specifically closes: a session that sat `pending` for many minutes
    // waiting on the owner's phone, then entered `issuing` just now, must not be treated as stale
    // just because it is old overall.
    const session = {issuingAt: new Date(now - 5_000), createdAt: new Date(now - 20 * 60_000)};
    expect(isMintSessionStale(session, now, 5 * 60_000)).toBe(false);
  });

  it("falls back to createdAt when issuingAt was never stamped (pre-migration data)", () => {
    const stale = {createdAt: new Date(now - 10 * 60_000)};
    const fresh = {createdAt: new Date(now - 10_000)};
    expect(isMintSessionStale(stale, now, 5 * 60_000)).toBe(true);
    expect(isMintSessionStale(fresh, now, 5 * 60_000)).toBe(false);
  });

  it("respects a configured non-default threshold", () => {
    const session = {issuingAt: new Date(now - 61_000), createdAt: new Date(now - 61_000)};
    expect(isMintSessionStale(session, now, 60_000)).toBe(true);
    expect(isMintSessionStale(session, now, 120_000)).toBe(false);
  });
});

describe("reconcileAnchoredSession (the anchored-reconcile path)", () => {
  const session = {
    sessionId: "session-1",
    dogTagIdDec: "42",
    dogTagIdField: "1234",
    root: ROOT,
    petId: "pet-1",
    txHash: "0xdeadbeef",
  };

  it("reconciles to bound when the chain shows the exact root anchored and valid", async () => {
    const {deps, boundSessionIds, linkedPets} = fakeDeps({onChainRoot: ROOT, valid: true});
    const outcome = await reconcileAnchoredSession(session, CLONE_ADDRESS, deps);
    expect(outcome).toEqual({reconciled: true, dogTagIdDec: "42", root: ROOT});
    expect(boundSessionIds).toEqual(["session-1"]);
    expect(linkedPets).toEqual([
      {
        petId: "pet-1",
        tag: {dogTagIdDec: "42", dogTagIdField: "1234", root: ROOT, issuedTx: "0xdeadbeef", cloneAddress: CLONE_ADDRESS},
      },
    ]);
  });

  it("matches the root case-insensitively", async () => {
    const {deps} = fakeDeps({onChainRoot: ROOT.toUpperCase(), valid: true});
    const outcome = await reconcileAnchoredSession(session, CLONE_ADDRESS, deps);
    expect(outcome.reconciled).toBe(true);
  });

  it("does not reconcile a session with no root - there is nothing to check on chain", async () => {
    const {deps, boundSessionIds} = fakeDeps();
    const outcome = await reconcileAnchoredSession({...session, root: undefined}, CLONE_ADDRESS, deps);
    expect(outcome).toEqual({reconciled: false, reason: "no-root"});
    expect(boundSessionIds).toEqual([]);
  });

  it("does not reconcile when the on-chain root is unset (never actually anchored)", async () => {
    const {deps, boundSessionIds} = fakeDeps({onChainRoot: `0x${"0".repeat(64)}`, valid: false});
    const outcome = await reconcileAnchoredSession(session, CLONE_ADDRESS, deps);
    expect(outcome).toEqual({reconciled: false, reason: "not-anchored"});
    expect(boundSessionIds).toEqual([]);
  });

  it("does not reconcile when the on-chain root belongs to a different session", async () => {
    const {deps} = fakeDeps({onChainRoot: OTHER_ROOT, valid: true});
    const outcome = await reconcileAnchoredSession(session, CLONE_ADDRESS, deps);
    expect(outcome).toEqual({reconciled: false, reason: "not-anchored"});
  });

  it("does not reconcile when the root is anchored but isValid reads false", async () => {
    const {deps} = fakeDeps({onChainRoot: ROOT, valid: false});
    const outcome = await reconcileAnchoredSession(session, CLONE_ADDRESS, deps);
    expect(outcome).toEqual({reconciled: false, reason: "not-anchored"});
  });

  it("fails closed on an unreadable chain, never guessing either way", async () => {
    const {deps, boundSessionIds} = fakeDeps({
      readProfileRoot: async () => {
        throw new Error("RPC timeout");
      },
    });
    const outcome = await reconcileAnchoredSession(session, CLONE_ADDRESS, deps);
    expect(outcome).toEqual({reconciled: false, reason: "chain-read-failed"});
    expect(boundSessionIds).toEqual([]);
  });

  it("skips linking a Pet when the session never had a petId", async () => {
    const {deps, boundSessionIds, linkedPets} = fakeDeps({onChainRoot: ROOT, valid: true});
    const outcome = await reconcileAnchoredSession({...session, petId: undefined}, CLONE_ADDRESS, deps);
    expect(outcome.reconciled).toBe(true);
    expect(boundSessionIds).toEqual(["session-1"]);
    expect(linkedPets).toEqual([]);
  });
});

describe("reconcileAnchoredSession (reverted-receipt detection, WP4.5 track 3)", () => {
  const session = {
    sessionId: "session-1",
    dogTagIdDec: "42",
    dogTagIdField: "1234",
    root: ROOT,
    petId: "pet-1",
    txHash: "0xdeadbeef",
  };

  it("flips to ready via markSessionRevertedReady when the tx receipt is reverted, without ever reading profileRoot/isValid", async () => {
    const {deps, boundSessionIds, revertedReady, readProfileRootCalls} = fakeDeps({
      readTxReceiptStatus: async () => "reverted",
    });
    const outcome = await reconcileAnchoredSession(session, CLONE_ADDRESS, deps);
    expect(outcome).toEqual({reconciled: false, reason: "reverted", txHash: "0xdeadbeef"});
    expect(revertedReady).toEqual([{sessionId: "session-1", txHash: "0xdeadbeef"}]);
    // The revert is already conclusive - no need to also ask what the chain's own state is, and
    // no risk of the not-anchored branch below stepping on this session afterward.
    expect(readProfileRootCalls).toEqual([]);
    expect(boundSessionIds).toEqual([]);
  });

  it("does not touch a session with no txHash yet - falls through to the ordinary not-anchored path", async () => {
    const {deps, revertedReady} = fakeDeps({onChainRoot: `0x${"0".repeat(64)}`, valid: false});
    const outcome = await reconcileAnchoredSession({...session, txHash: undefined}, CLONE_ADDRESS, deps);
    expect(outcome).toEqual({reconciled: false, reason: "not-anchored"});
    expect(revertedReady).toEqual([]);
  });

  it("leaves a session whose receipt is still pending (not yet mined) to fall through to not-anchored, never guessing reverted", async () => {
    const {deps, revertedReady} = fakeDeps({
      readTxReceiptStatus: async () => "pending",
      onChainRoot: `0x${"0".repeat(64)}`,
      valid: false,
    });
    const outcome = await reconcileAnchoredSession(session, CLONE_ADDRESS, deps);
    expect(outcome).toEqual({reconciled: false, reason: "not-anchored"});
    expect(revertedReady).toEqual([]);
  });

  it("a receipt that reads back success is not treated as reverted - the ordinary anchored-reconcile path still runs and still succeeds", async () => {
    const {deps, boundSessionIds, revertedReady} = fakeDeps({
      readTxReceiptStatus: async () => "success",
      onChainRoot: ROOT,
      valid: true,
    });
    const outcome = await reconcileAnchoredSession(session, CLONE_ADDRESS, deps);
    expect(outcome).toEqual({reconciled: true, dogTagIdDec: "42", root: ROOT});
    expect(boundSessionIds).toEqual(["session-1"]);
    expect(revertedReady).toEqual([]);
  });

  it("fails closed (chain-read-failed) when the receipt read itself throws, touching neither bound nor reverted-ready state", async () => {
    const {deps, boundSessionIds, revertedReady} = fakeDeps({
      readTxReceiptStatus: async () => {
        throw new Error("RPC timeout");
      },
    });
    const outcome = await reconcileAnchoredSession(session, CLONE_ADDRESS, deps);
    expect(outcome).toEqual({reconciled: false, reason: "chain-read-failed"});
    expect(boundSessionIds).toEqual([]);
    expect(revertedReady).toEqual([]);
  });
});
