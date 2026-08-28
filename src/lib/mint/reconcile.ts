import "server-only";
import {MintSession} from "@/lib/models/MintSession";
import {Pet} from "@/lib/models/Pet";
import {readIsValidRoot, readProfileRoot} from "@/lib/chainRead";

/**
 * The fields `reconcileAnchoredSession` needs from a `MintSessionDoc` - deliberately a narrow
 * structural type (not `MintSessionDoc` itself) so the pure function below stays independent of
 * mongoose, exactly like `lib/mint/flow.ts`'s `MintSessionRow`/`MintFlowStore` split does for the
 * rest of the mint flow.
 */
export interface ReconcileSessionInput {
  sessionId: string;
  dogTagIdDec: string;
  dogTagIdField: string;
  root?: string;
  petId?: string;
  txHash?: string;
}

export interface LinkedDogTag {
  dogTagIdDec: string;
  dogTagIdField: string;
  root: string;
  issuedTx?: string;
  cloneAddress: string;
}

/** Everything `reconcileAnchoredSession` needs to do its one job, injected so it can be unit
 * tested against an in-memory fake (both the chain reads AND the two persistence writes) with no
 * live database and no RPC - the same dependency-injection shape `lib/booking/book.ts`'s
 * `BookingStore` and `lib/mint/flow.ts`'s `MintFlowStore` already use for this exact reason. */
export interface ReconcileDeps {
  /** `DogTagSBTConsent.profileRoot(dogTagIdField)` for this session's id. */
  readProfileRoot(dogTagIdFieldDec: string): Promise<string>;
  /** `VetIssuer.isValid(root)` on the clinic's clone. */
  readIsValidRoot(root: string): Promise<boolean>;
  /** Marks the session `bound`. Idempotent - only ever called after a fresh chain read confirms
   * the anchor, so calling it again for an already-`bound` session is harmless. */
  markSessionBound(sessionId: string): Promise<void>;
  /** The SAME terminal write `POST /api/tags/issue/:sessionId/confirm` always performed on a
   * normal (non-recovery) success: links the tag onto the Pet record. No-ops when the session has
   * no `petId`. */
  linkPetDogTag(petId: string, tag: LinkedDogTag): Promise<void>;
}

export type ReconcileOutcome =
  | {reconciled: true; dogTagIdDec: string; root: string}
  | {reconciled: false; reason: "no-root" | "chain-read-failed" | "not-anchored"};

/**
 * Was this session's tag actually anchored on chain, even though the LOCAL record does not (yet,
 * or any more) say `bound`? wp4-vet.md issuance step 5's own confirmation contract - "reads back
 * `profileRoot(id) == root` and `isValid(root)` before setting `bound` (a receipt is not proof)" -
 * applies identically no matter who is asking: the staff UI polling right after its own `issueTag`
 * tx, the worker checking a session a crashed process left stranded at boot, or an operator
 * manually retrying a session the worker wrongly marked `error`. Three call sites (the confirm
 * route, the retry route, and the worker's boot recovery) share this one implementation so a
 * session whose transaction actually succeeded always has exactly one path back to `bound` -
 * see each call site's own doc comment for why it needed this.
 */
export async function reconcileAnchoredSession(
  session: ReconcileSessionInput,
  cloneAddress: string,
  deps: ReconcileDeps,
): Promise<ReconcileOutcome> {
  if (!session.root) return {reconciled: false, reason: "no-root"};

  let onChainRoot: string;
  let valid: boolean;
  try {
    onChainRoot = await deps.readProfileRoot(session.dogTagIdField);
    valid = await deps.readIsValidRoot(session.root);
  } catch {
    // Fail-closed, same as every other chain read in this app (chainRead.ts's doc comment): an
    // unreadable chain is neither "anchored" nor "not anchored" - callers treat this as transient
    // and leave the session's current state untouched rather than guessing either way.
    return {reconciled: false, reason: "chain-read-failed"};
  }

  if (onChainRoot.toLowerCase() !== session.root.toLowerCase() || !valid) {
    return {reconciled: false, reason: "not-anchored"};
  }

  await deps.markSessionBound(session.sessionId);
  if (session.petId) {
    await deps.linkPetDogTag(session.petId, {
      dogTagIdDec: session.dogTagIdDec,
      dogTagIdField: session.dogTagIdField,
      root: session.root,
      issuedTx: session.txHash,
      cloneAddress,
    });
  }

  return {reconciled: true, dogTagIdDec: session.dogTagIdDec, root: session.root};
}

/** Mongoose + real-chain `ReconcileDeps` - the production adapter shared by every call site. */
export function mongoReconcileDeps(sbtAddress: `0x${string}`, cloneAddress: `0x${string}`): ReconcileDeps {
  return {
    readProfileRoot: (dogTagIdFieldDec) => readProfileRoot(sbtAddress, dogTagIdFieldDec),
    readIsValidRoot: (root) => readIsValidRoot(cloneAddress, root as `0x${string}`),
    async markSessionBound(sessionId) {
      await MintSession.updateOne(
        {sessionId},
        {$set: {status: "bound", resolvedAt: new Date()}, $unset: {errorStage: "", errorReason: ""}},
      );
    },
    async linkPetDogTag(petId, tag) {
      await Pet.updateOne(
        {petId},
        {
          $set: {
            "dogTag.dogTagIdDec": tag.dogTagIdDec,
            "dogTag.dogTagIdField": tag.dogTagIdField,
            "dogTag.root": tag.root,
            "dogTag.status": "active",
            "dogTag.issuedTx": tag.issuedTx,
            "dogTag.cloneAddress": tag.cloneAddress,
            "dogTag.issuedAt": new Date(),
          },
        },
      );
    },
  };
}

/** The age guard for the worker's boot recovery (wp4-vet.md's own word for this: "stale"). A
 * session's clock starts the moment it actually enters `issuing` (`issuingAt`, stamped by
 * `POST .../tx`), never `createdAt` - a session can sit `pending` for minutes waiting on the
 * owner's phone before ever reaching `issuing`, so `createdAt` would count that ordinary wait
 * against the threshold and flip a transaction that has been in flight for mere seconds. Sessions
 * from before `issuingAt` existed fall back to `createdAt` rather than being treated as
 * infinitely fresh (or crashing on a missing field). */
export function isMintSessionStale(
  session: {issuingAt?: Date | string; createdAt: Date | string},
  nowMs: number,
  staleMs: number,
): boolean {
  const enteredIssuingAtMs = new Date(session.issuingAt ?? session.createdAt).getTime();
  return nowMs - enteredIssuingAtMs >= staleMs;
}
