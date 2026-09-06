/**
 * The chain-reread that decides whether an `addSecondaryOwner`/`revokeSecondaryOwner` write
 * actually landed - shared by the confirm route and boot recovery, mirroring `lib/mint/reconcile.ts`'s
 * `reconcileAnchoredSession` ("a receipt is not proof").
 *
 * **`isSecondary(commitment)` is the DECISIVE check, never `secondaryCount`/`delegationRoot`.**
 * `delegationRoot` is a pure function of the tag's current 16-value multiset (`docs/DELEGATION.md`
 * section 4.2) - a concurrent, unrelated add-then-revoke by a DIFFERENT clinic on the SAME tag
 * (Kenneth's decision, plan section 9 item 2: any Active clinic may write) can move it right back
 * to its pre-write value even though THIS session's own write genuinely landed, which would be a
 * false refusal if the root were the gate. `secondaryCount` moves for the identical unrelated
 * reason. `isSecondary(dogTagIdField, commitment)` for THIS session's own specific commitment can
 * only flip because of THIS write (or a later one targeting the same commitment) - it is the one
 * read that answers "did MY write happen" rather than "did SOME write happen". The other two are
 * still read and recorded (`secondaryCountAtConfirm`/`delegationRootAtConfirm`) for the audit
 * trail, never as part of the pass/fail decision.
 */
export interface DelegationReconcileDeps {
  /** `DelegationRegistry.isSecondary(dogTagId, commitment)`. */
  isSecondary(dogTagIdField: string, commitment: string): Promise<boolean>;
  /** `DelegationRegistry.secondaryCount(dogTagId)` - audit trail only. */
  secondaryCount(dogTagIdField: string): Promise<number>;
  /** `DelegationRegistry.delegationRoot(dogTagId)` - audit trail only. */
  delegationRoot(dogTagIdField: string): Promise<string>;
  /** The `addSecondaryOwner`/`revokeSecondaryOwner` transaction's own receipt status, read
   * directly - same `"pending"` (not yet mined) / `"success"` / `"reverted"` shape as
   * `chainRead.ts`'s `readTxReceiptStatus`, and the same reason `lib/mint/reconcile.ts` checks it
   * directly rather than inferring a revert from `isSecondary` alone: a reverted tx and a merely
   * slow one both leave `isSecondary` unchanged, so only the receipt itself can tell them apart. */
  txReceiptStatus(txHash: string): Promise<"success" | "reverted" | "pending">;
}

export interface DelegationReconcileInput {
  kind: "add" | "revoke";
  dogTagIdField: string;
  commitment: string;
  txHash?: string;
}

export type DelegationReconcileOutcome =
  | {reconciled: true; secondaryCount: number; delegationRoot: string}
  | {reconciled: false; reason: "chain-read-failed"}
  | {reconciled: false; reason: "reverted"; txHash: string}
  | {reconciled: false; reason: "not-yet"};

export async function reconcileDelegationWrite(
  session: DelegationReconcileInput,
  deps: DelegationReconcileDeps,
): Promise<DelegationReconcileOutcome> {
  if (session.txHash) {
    let receiptStatus: "success" | "reverted" | "pending";
    try {
      receiptStatus = await deps.txReceiptStatus(session.txHash);
    } catch {
      return {reconciled: false, reason: "chain-read-failed"};
    }
    // A confirmed revert is conclusive - there is nothing left to wait for (mirrors
    // reconcileAnchoredSession's identical early-exit for issueTag). "pending"/"success" both fall
    // through to the isSecondary check below: "pending" because it is simply not conclusive yet,
    // "success" because a mined-and-succeeded receipt still needs the DECISIVE isSecondary check -
    // a receipt is not proof of the SPECIFIC state change this session expected.
    if (receiptStatus === "reverted") return {reconciled: false, reason: "reverted", txHash: session.txHash};
  }

  let isSecondaryNow: boolean;
  let count: number;
  let root: string;
  try {
    [isSecondaryNow, count, root] = await Promise.all([
      deps.isSecondary(session.dogTagIdField, session.commitment),
      deps.secondaryCount(session.dogTagIdField),
      deps.delegationRoot(session.dogTagIdField),
    ]);
  } catch {
    return {reconciled: false, reason: "chain-read-failed"};
  }

  const expectedActive = session.kind === "add";
  if (isSecondaryNow === expectedActive) {
    return {reconciled: true, secondaryCount: count, delegationRoot: root};
  }
  return {reconciled: false, reason: "not-yet"};
}
