import "server-only";
import {recordTypeKey} from "@dogtag/standard";
import {RecordArtifact} from "@/lib/models/RecordArtifact";
import type {RecordErrorStage} from "@/lib/models/RecordArtifact";
import {readIsValidRoot, readIssuedBy, readRecordTypeOf, readRootIssuer, readTxReceiptStatus} from "@/lib/chainRead";

/** Surfaced verbatim in the wizard's error banner - mirrors `ISSUE_TX_REVERTED_MESSAGE`
 * (`lib/mint/reconcile.ts`) exactly. */
export const RECORD_TX_REVERTED_MESSAGE = "Transaction reverted on chain - you can issue again.";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HEX32 = `0x${"0".repeat(64)}`;

export interface ReconcileRecordInput {
  recordId: string;
  root: string;
  /** The clinic's OWN configured `VetIssuer` clone (`ClinicSettings.cloneAddress`) - the record is
   * only genuinely anchored by THIS clinic if `rootIssuer(root)` resolves to exactly this address,
   * never merely "some clone" (the identical anti-substitution reasoning `verify.ts`'s
   * `RpcAdapter.rootIssuer` doc comment states for every other artifact type this protocol
   * verifies). */
  expectedCloneAddress: string;
  /** The `issuer.operator` leaf's own committed value (`RecordArtifactDoc.chain.operator`) -
   * `issuedBy(root)` must equal exactly this, never merely "some whitelisted operator". */
  expectedOperator: string;
  txHash?: string;
}

/** Everything `reconcileAnchoredRecord` needs to do its one job, injected so it is unit-testable
 * against an in-memory fake with no live database and no RPC - the identical dependency-injection
 * shape `lib/mint/reconcile.ts`'s `ReconcileDeps` already uses for the tag/profile side. */
export interface ReconcileRecordDeps {
  /** `VetIssuerFactory.rootIssuer(root)` against THIS deployment's OWN configured factory. */
  readRootIssuer(root: string): Promise<string>;
  /** `VetIssuer.isValid(root)` on the RESOLVED clone. */
  readIsValidRoot(cloneAddress: string, root: string): Promise<boolean>;
  /** `VetIssuer.recordTypeOf(root)` on the RESOLVED clone. */
  readRecordTypeOf(cloneAddress: string, root: string): Promise<string>;
  /** `VetIssuer.issuedBy(root)` on the RESOLVED clone. */
  readIssuedBy(cloneAddress: string, root: string): Promise<string>;
  /** The `issueRecord` transaction's own receipt status - see `lib/mint/reconcile.ts`'s identical
   * field for why a CONFIRMED revert gets its own signal instead of falling through to
   * `not-anchored` (the exact same WP4.5 track 3 forensic case applies here unchanged: the on-chain
   * refund tail can OutOfGas after the mapping write, or the whole call can revert for any other
   * reason, and either way the receipt itself is conclusive where a bare state re-read is not). */
  readTxReceiptStatus(txHash: string): Promise<"success" | "reverted" | "pending">;
  /** Marks the record `active` with the anchoring metadata the confirm route's own receipt read
   * supplies (never re-derived here) - idempotent, safe to call again for an already-active record. */
  markRecordActive(recordId: string, anchor: {contract: string; blockNumber?: number; blockTime?: Date}): Promise<void>;
  markRecordError(recordId: string, stage: RecordErrorStage): Promise<void>;
  /** The reverted-tx recovery write (mirrors `markSessionRevertedReady`): back to `"draft"` (never
   * `"error"`) - the leaves and root are already computed and already verified, so the SAME record
   * can retry `issueRecord` immediately with a fresh transaction, no redraft needed. */
  markRecordRevertedDraft(recordId: string, txHash: string): Promise<void>;
}

export type ReconcileRecordOutcome =
  | {reconciled: true; contract: string}
  | {reconciled: false; reason: "chain-read-failed" | "not-anchored"}
  | {reconciled: false; reason: "reverted"; txHash: string};

/**
 * Was this record actually anchored on chain, even though the LOCAL row does not (yet, or any
 * more) say `active`? The plan's own non-negotiable, verbatim: "confirm is fail-closed (all four
 * chain reads must agree; a receipt is not proof)". The four reads, all against the SAME resolved
 * clone (never a clone the caller merely names):
 *
 * 1. `rootIssuer(root)` (via THIS deployment's own factory) resolves to `expectedCloneAddress`
 *    exactly - not the zero address (never indexed) and not some OTHER clone.
 * 2. `isValid(root)` on that clone.
 * 3. `recordTypeOf(root)` on that clone equals `recordTypeKey("VACCINATION")` - the ALL-ZERO word
 *    is a FAILURE here, never a pass (specs/leaf-commitment.md section 16's on-chain binding rule
 *    2: "populated by both tag issuance and issueRecord" - a genuine vaccination record is never
 *    zero once anchored).
 * 4. `issuedBy(root)` on that clone equals `expectedOperator` exactly - the committed
 *    `issuer.operator` leaf's own value, never merely "some whitelisted operator".
 *
 * Every chain read below is wrapped in ONE `try/catch`: a read that THROWS is `chain-read-failed`
 * (transient - the caller leaves the record's current state untouched, exactly like `lib/mint/
 * reconcile.ts`'s own doc comment), never silently treated as a pass or a fail. Reads that all
 * SUCCEED but DISAGREE with any of the four checks above are `not-anchored` - a terminal
 * disagreement, not a transient one.
 */
export async function reconcileAnchoredRecord(input: ReconcileRecordInput, deps: ReconcileRecordDeps): Promise<ReconcileRecordOutcome> {
  if (input.txHash) {
    let receiptStatus: "success" | "reverted" | "pending";
    try {
      receiptStatus = await deps.readTxReceiptStatus(input.txHash);
    } catch {
      return {reconciled: false, reason: "chain-read-failed"};
    }
    if (receiptStatus === "reverted") {
      await deps.markRecordRevertedDraft(input.recordId, input.txHash);
      return {reconciled: false, reason: "reverted", txHash: input.txHash};
    }
  }

  let resolvedClone: string;
  let valid: boolean;
  let chainRecordType: string;
  let issuedByAddr: string;
  try {
    resolvedClone = await deps.readRootIssuer(input.root);
    if (resolvedClone.toLowerCase() === ZERO_ADDRESS) {
      return {reconciled: false, reason: "not-anchored"};
    }
    [valid, chainRecordType, issuedByAddr] = await Promise.all([
      deps.readIsValidRoot(resolvedClone, input.root),
      deps.readRecordTypeOf(resolvedClone, input.root),
      deps.readIssuedBy(resolvedClone, input.root),
    ]);
  } catch {
    // Fail-closed, same as every other chain read in this app: an unreadable chain is neither
    // "anchored" nor "not anchored" - leave the record's current state untouched.
    return {reconciled: false, reason: "chain-read-failed"};
  }

  const expectedRecordType = recordTypeKey("VACCINATION");
  const agrees =
    resolvedClone.toLowerCase() === input.expectedCloneAddress.toLowerCase() &&
    valid &&
    chainRecordType.toLowerCase() === expectedRecordType.toLowerCase() &&
    chainRecordType.toLowerCase() !== ZERO_HEX32 && // defensive - keccak256("VACCINATION") is never the zero word, but never trust that implicitly
    issuedByAddr.toLowerCase() === input.expectedOperator.toLowerCase();

  if (!agrees) {
    return {reconciled: false, reason: "not-anchored"};
  }

  await deps.markRecordActive(input.recordId, {contract: resolvedClone});
  return {reconciled: true, contract: resolvedClone};
}

/** Mongoose + real-chain `ReconcileRecordDeps` - the production adapter shared by every call site
 * (the confirm route, the retry-equivalent, and the worker's boot recovery). */
export function mongoReconcileRecordDeps(factoryAddress: `0x${string}`): ReconcileRecordDeps {
  return {
    readRootIssuer: (root) => readRootIssuer(factoryAddress, root as `0x${string}`),
    readIsValidRoot: (cloneAddress, root) => readIsValidRoot(cloneAddress as `0x${string}`, root as `0x${string}`),
    readRecordTypeOf: (cloneAddress, root) => readRecordTypeOf(cloneAddress as `0x${string}`, root as `0x${string}`),
    readIssuedBy: (cloneAddress, root) => readIssuedBy(cloneAddress as `0x${string}`, root as `0x${string}`),
    readTxReceiptStatus: (txHash) => readTxReceiptStatus(txHash as `0x${string}`),
    async markRecordActive(recordId, anchor) {
      await RecordArtifact.updateOne(
        {recordId},
        {
          $set: {
            status: "active",
            "chain.contract": anchor.contract.toLowerCase(),
            "chain.blockNumber": anchor.blockNumber,
            "chain.blockTime": anchor.blockTime,
            "chain.issuedAt": new Date(),
          },
          $unset: {errorStage: ""},
        },
      );
    },
    async markRecordError(recordId, stage) {
      await RecordArtifact.updateOne({recordId}, {$set: {status: "error", errorStage: stage}});
    },
    async markRecordRevertedDraft(recordId, txHash) {
      await RecordArtifact.updateOne(
        {recordId, "chain.txHash": txHash},
        {$set: {status: "draft"}, $unset: {"chain.txHash": "", issuingAt: "", errorStage: ""}},
      );
    },
  };
}

/** The worker boot-recovery age guard - mirrors `isMintSessionStale` exactly (measured from
 * `issuingAt`, never `createdAt`). */
export function isRecordStale(record: {issuingAt?: Date | string}, nowMs: number, staleMs: number): boolean {
  if (!record.issuingAt) return false;
  return nowMs - new Date(record.issuingAt).getTime() >= staleMs;
}
