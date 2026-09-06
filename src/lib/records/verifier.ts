import {zeroAddress} from "viem";
import {recordTypeKey, verifyRecordArtifact, type RecordArtifact as RecordArtifactWire} from "@dogtag/standard";
import {recordValidUntilCutoffUtc} from "@/lib/records/validity";

/**
 * The record-presentment verifier (plan section 11.2 V6) - checks a THIRD-PARTY-PRESENTED
 * `RecordArtifact` against the on-chain binding rules `specs/leaf-commitment.md` section 16 states
 * verbatim (five numbered checks), never assuming the presenting clinic is THIS clinic's own (unlike
 * `lib/records/reconcile.ts`'s `reconcileAnchoredRecord`, which checks against ITS OWN configured
 * clone - this module cross-checks the artifact's OWN disclosed `issuer.*` leaves against what the
 * chain independently reports, exactly the "resolve independently, then compare against the
 * document's claim" pattern `@dogtag/standard`'s `verify.ts` already uses for every other pillar).
 *
 * Mirrors `lib/tags/verifier.ts`'s role for tags, but as ONE function, not two - there is no
 * "different callers need different subsets" split here the way booking-vs-import needed for tags
 * (this module has exactly one caller: presenting a record for a stranger to check).
 *
 * NEVER a bare true/false (`VerifyRedactedPanel.tsx`'s own established precedent, mirrored here):
 * every distinct way this can fail is its own named stage, and "verified" itself carries a
 * Valid/Expired/Revoked three-way, never collapsed into a single boolean.
 */
export interface RecordChainDeps {
  /** `VetIssuerFactory.rootIssuer(root)` against THIS deployment's own configured factory - never a
   * factory the artifact or its presenter names (the anti-substitution reasoning check 1 below
   * states). */
  readRootIssuer(root: string): Promise<string>;
  /** `VetIssuer.recordTypeOf(root)` on the RESOLVED clone (check 1's own output, never a clone the
   * artifact merely claims). */
  readRecordTypeOf(cloneAddress: string, root: string): Promise<string>;
  /** `VetIssuer.isValid(root)` on the resolved clone. */
  readIsValidRoot(cloneAddress: string, root: string): Promise<boolean>;
  /** `VetIssuer.issuedBy(root)` on the resolved clone. */
  readIssuedBy(cloneAddress: string, root: string): Promise<string>;
}

export type RecordVerifyStage =
  | {stage: "crypto_failed"}
  | {stage: "chain_unreadable"}
  | {
      stage: "not_anchored";
      /** `root_unset`: the factory never indexed this root at all - never issued (or the artifact
       * names a root that does not exist on this chain). `issuer_mismatch`: the factory resolves
       * this root to a DIFFERENT clone than the artifact's own disclosed `issuer.contract` leaf
       * claims - either a lie, or the artifact is stale/wrong about who issued it.
       * `record_type_mismatch`: the resolved clone's `recordTypeOf(root)` disagrees with the
       * artifact's own disclosed `recordType` leaf. `operator_mismatch`: the resolved clone's
       * `issuedBy(root)` disagrees with the artifact's own disclosed `issuer.operator` leaf. */
      reason: "root_unset" | "issuer_mismatch" | "record_type_mismatch" | "operator_mismatch";
    }
  /** Check 5 (leaf-commitment.md section 16): the disclosed `issuer.chainId` leaf does not match the
   * chain this verifier is actually connected to - a trivial equality check, stated explicitly so an
   * artifact genuinely anchored on one chain can never be replayed as if anchored on another whose
   * contract addresses happen to collide with the first's. */
  | {stage: "wrong_chain"}
  | {
      stage: "verified";
      issuerClone: string;
      recordType: string;
      /** `isValid(root) === false` at this point can only mean genuinely revoked (never "never
       * issued" - check 1 already proved `rootIssuer` resolves non-zero to the claimed clone, which
       * the clone's own `issueRecord` only ever sets atomically together with `issuedAt`), so this
       * three-way is exhaustive: `isValid` false is always `"revoked"`; `isValid` true splits on the
       * disclosed `validUntil` leaf against `lib/records/validity.ts`'s own UTC-end-of-day cutoff -
       * the SAME boundary rule V4's Records tab list uses, never a second, independently-reasoned
       * date comparison. */
      validity: "valid" | "expired" | "revoked";
    };

const REQUIRED_LEAF_KEY_PATHS = ["issuer.contract", "issuer.operator", "issuer.chainId", "recordType"] as const;

function leafValue(artifact: RecordArtifactWire, keyPath: string): string | undefined {
  return artifact.disclosed.find((l) => l.keyPath === keyPath)?.value;
}

/**
 * The full pipeline: crypto self-check, then the five on-chain binding checks, then (only once
 * every check agrees) the Valid/Expired/Revoked classification. `currentChainId` is this
 * deployment's own configured ROAX chain id (`roax.id`) - never read from the artifact itself,
 * matching check 5's own "the chain the verifier is ACTUALLY connected to" wording.
 */
export async function verifyPresentedRecordArtifact(
  artifact: RecordArtifactWire,
  deps: RecordChainDeps,
  currentChainId: number,
): Promise<RecordVerifyStage> {
  if (!verifyRecordArtifact(artifact)) return {stage: "crypto_failed"};

  // verifyRecordArtifact already guarantees every non-maskable keyPath (a superset of the four
  // named here) is disclosed - these lookups can never come back undefined on a payload that
  // reached this point, but are read defensively (never a non-null assertion) all the same.
  const claimedContract = leafValue(artifact, "issuer.contract");
  const claimedOperator = leafValue(artifact, "issuer.operator");
  const claimedChainId = leafValue(artifact, "issuer.chainId");
  const claimedRecordType = leafValue(artifact, "recordType");
  if (!claimedContract || !claimedOperator || !claimedChainId || !claimedRecordType) {
    // Defensive only - see comment above for why this should be unreachable in practice.
    return {stage: "crypto_failed"};
  }

  // Check 5 first - a trivial comparison, no contract read at all, and the cheapest possible way to
  // refuse an artifact anchored on a different chain before spending any RPC call on it.
  if (Number(claimedChainId) !== currentChainId) return {stage: "wrong_chain"};

  let resolvedClone: string;
  try {
    resolvedClone = await deps.readRootIssuer(artifact.root);
  } catch {
    return {stage: "chain_unreadable"};
  }
  if (resolvedClone.toLowerCase() === zeroAddress) {
    return {stage: "not_anchored", reason: "root_unset"};
  }
  if (resolvedClone.toLowerCase() !== claimedContract.toLowerCase()) {
    return {stage: "not_anchored", reason: "issuer_mismatch"};
  }

  let chainRecordType: string;
  let valid: boolean;
  let issuedByAddr: string;
  try {
    [chainRecordType, valid, issuedByAddr] = await Promise.all([
      deps.readRecordTypeOf(resolvedClone, artifact.root),
      deps.readIsValidRoot(resolvedClone, artifact.root),
      deps.readIssuedBy(resolvedClone, artifact.root),
    ]);
  } catch {
    return {stage: "chain_unreadable"};
  }

  if (chainRecordType.toLowerCase() !== recordTypeKey(claimedRecordType).toLowerCase()) {
    return {stage: "not_anchored", reason: "record_type_mismatch"};
  }
  if (issuedByAddr.toLowerCase() !== claimedOperator.toLowerCase()) {
    return {stage: "not_anchored", reason: "operator_mismatch"};
  }

  if (!valid) {
    return {stage: "verified", issuerClone: resolvedClone.toLowerCase(), recordType: claimedRecordType, validity: "revoked"};
  }

  const validUntil = leafValue(artifact, "validUntil");
  const validity = validUntil && Date.now() >= recordValidUntilCutoffUtc(validUntil).getTime() ? "expired" : "valid";
  return {stage: "verified", issuerClone: resolvedClone.toLowerCase(), recordType: claimedRecordType, validity};
}

// Exported for callers that need to name every disclosed keyPath a record artifact is REQUIRED to
// carry before this verifier can even attempt the chain-binding checks (display/diagnostics only -
// `verifyRecordArtifact` itself is the actual enforcement, via its own non-maskable-set check).
export const RECORD_VERIFY_REQUIRED_LEAF_KEY_PATHS = REQUIRED_LEAF_KEY_PATHS;
