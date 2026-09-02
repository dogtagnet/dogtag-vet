import {verifyRedactedArtifact, type RedactedTagArtifact} from "@dogtag/standard";
import {resolveTagRootAndIssuer, type TagDataChainDeps} from "@/lib/tags/verifier";

/**
 * The pure verification pipeline behind WP4.10V item 5's "Verify a redacted artifact" staff page -
 * plans/wp4.10-masked-export.md's own recipe: `verifyRedactedArtifact` -> chain binding
 * (`profileRoot == root`, `rootIssuer`, `isValid` on the ISSUER clone) -> an HONEST, staged result,
 * never a bare true/false. Reuses the shared verifier's `resolveTagRootAndIssuer` (plan section
 * 2.3, the same function the WP4.4 booking path and the WP4.9 import ceremony already share) for
 * the chain-read plumbing, rather than a third, independently-maintained copy of it.
 *
 * Stages, in the order a caller reaches them (each one is a legitimate, distinct thing to tell
 * staff - never collapsed into a bare "verified: false"):
 *
 * 1. `crypto_failed` - `verifyRedactedArtifact` itself returned `false`: the document does not
 *    hold together at all (tampered, corrupted, or a genuine protocol violation - overlap,
 *    duplicate keyPath, wrong reserved count, ...). No chain read is ever attempted past this -
 *    there is no point spending an RPC call on a document that fails on its own terms.
 * 2. `malformed_claim` - the pasted `dogTagIdDec`/`dogTagIdField` pair is internally inconsistent
 *    (both present, and one does not derive the other) - a claim problem, not a chain problem.
 * 3. `chain_unreadable` - a chain read itself failed (RPC error/timeout) - DISTINCT from a failed
 *    verification: the document may be perfectly genuine, this deployment just could not confirm
 *    it against the chain right now. Never conflated with `crypto_failed`.
 * 4. `not_anchored` - the chain was read successfully, but this exact root is not the live one for
 *    this `dogTagIdField`: `reason: "never_issued"` (the live root is the zero hash - this ID has
 *    never been anchored at all) or `reason: "root_mismatch"` (the live root is some OTHER,
 *    nonzero root - this artifact's root was superseded, or never matched what is actually
 *    anchored). Either way: the document is PURE-VERIFIED (its own crypto holds), just not
 *    currently backed by an on-chain anchor under this claim.
 * 5. `chain_anchored_issuer_unknown` - defensive only, per `resolveTagRootAndIssuer`'s own doc
 *    comment: a nonzero root with no indexed issuer should never occur on a consistent chain.
 * 6. `verified` - the root is genuinely anchored (`profileRoot(dogTagIdField) == root`) AND its
 *    issuer resolved. `isValid` (`VetIssuer.isValid(root)` on that ISSUER clone) still might be
 *    `false` - a revoked (or otherwise currently-invalid) but genuinely-issued tag - so this stage
 *    alone is not "safe to trust", the caller reads `isValid` too.
 *
 * "Which fields are masked" is deliberately NOT part of this result: `artifact.disclosed`/
 * `artifact.obfuscatedLeafHashes`/`artifact.reservedLeafHashes` are already fully known to any
 * caller holding the parsed artifact (this function adds no information about them - masking
 * reveals nothing about a hidden field's identity beyond its keyPath already being visible or
 * not), so the ROUTE/UI reads that display context directly off the artifact instead of this
 * function threading it through a second time.
 */
export type VerifyRedactedArtifactResult =
  | {stage: "crypto_failed"}
  | {stage: "malformed_claim"}
  | {stage: "chain_unreadable"}
  | {stage: "not_anchored"; reason: "never_issued" | "root_mismatch"}
  | {stage: "chain_anchored_issuer_unknown"}
  | {stage: "verified"; issuerClone: string; isValid: boolean};

export async function verifyRedactedArtifactSubmission(
  artifact: RedactedTagArtifact,
  deps: Pick<TagDataChainDeps, "readProfileRoot" | "readRootIssuer" | "readIsValidRoot">,
): Promise<VerifyRedactedArtifactResult> {
  // No `expectedIdentityLeaves` oracle - staff verifying an arbitrary pasted artifact holds no
  // vet-attested KYC record to cross-check against, the exact "third party checking only that the
  // artifact recomputes its own root" case `redactedArtifact.ts`'s own file header names.
  if (!verifyRedactedArtifact(artifact)) {
    return {stage: "crypto_failed"};
  }

  const resolved = await resolveTagRootAndIssuer(deps, {dogTagIdDec: artifact.dogTagIdDec, dogTagIdField: artifact.dogTagIdField});
  if (!resolved.ok) {
    if (resolved.reason === "malformed_claim") return {stage: "malformed_claim"};
    if (resolved.reason === "chain_unreadable") return {stage: "chain_unreadable"};
    if (resolved.reason === "root_unset") return {stage: "not_anchored", reason: "never_issued"};
    return {stage: "chain_anchored_issuer_unknown"}; // reason === "issuer_unknown"
  }

  if (resolved.root.toLowerCase() !== artifact.root.toLowerCase()) {
    return {stage: "not_anchored", reason: "root_mismatch"};
  }

  let isValid: boolean;
  try {
    isValid = await deps.readIsValidRoot(resolved.issuerClone, resolved.root);
  } catch {
    return {stage: "chain_unreadable"};
  }

  return {stage: "verified", issuerClone: resolved.issuerClone, isValid};
}
