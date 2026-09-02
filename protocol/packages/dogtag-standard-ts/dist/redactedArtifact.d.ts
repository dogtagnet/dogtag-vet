import type { OpenedLeaf } from "./profileBind.js";
/**
 * The wire format (WP4.10 plan section 2): a `TagArtifact`-shaped custody record with some
 * attribute leaves opened (`disclosed`) and the rest named only by their opaque hash
 * (`obfuscatedLeafHashes`). A full, unredacted artifact is the DEGENERATE case of this same shape:
 * `obfuscatedLeafHashes: []`, `disclosed` holding every attribute leaf - so a plain `TagArtifact`
 * (rename `leaves` to `disclosed`, add an empty `obfuscatedLeafHashes`) already satisfies it.
 */
export interface RedactedTagArtifact {
    protocolVersion: string;
    /** The schema-registry `$id` this credential's record type was issued/received against. Not
     * consulted by this pure verifier (registry SHAPE and leaf-commitment ENCODING are independent
     * axes - specs/schemas/README.md); carried through for callers/registry validation. */
    schemaId?: string;
    dogTagIdDec?: string;
    /** The canonical on-chain dogTagId field (`dogTagIdField` in profileBind.ts) - the
     * `profileRoot(dogTagIdField) == root` binding key. OUTSIDE the tree: never a leaf, never
     * maskable, and not itself checked by this pure verifier (plan step 5 - a caller's on-chain job). */
    dogTagIdField: string;
    root: string;
    disclosed: OpenedLeaf[];
    obfuscatedLeafHashes: string[];
    reservedLeafHashes: string[];
    issuerClone: string;
}
export interface VerifyRedactedArtifactOpts {
    /** Optional identity cross-check oracle - when supplied, the `owner.identity.*` subset of
     * `disclosed` must equal this set exactly (vet-attested KYC cross-check), mirroring
     * `verifyLeafCommitment`'s mandatory `expectedIdentityLeaves`. Omitted by a verifier with no such
     * oracle (e.g. a third party checking only that the artifact recomputes its own root). */
    expectedIdentityLeaves?: OpenedLeaf[];
}
/**
 * Verify a {@link RedactedTagArtifact}: does `root` really commit to exactly
 * `[3 reserved hashes] + [obfuscatedLeafHashes] + [disclosed]`, with every disclosed leaf hash
 * RECOMPUTED from its opening (never trusted), and does no disclosed leaf collide with an owner-
 * control keyPath, a duplicate keyPath, or an opaque (obfuscated/reserved) hash?
 *
 * Fail-closed by construction, exactly like `verifyLeafCommitment`: every check below can only turn
 * a `true` into `false`, and any exception thrown while parsing a malformed opening is caught and
 * treated as rejection, never propagated as an ambiguous crash. Checks, in order (plan section 2):
 *
 * 1. Exactly 3 reserved leaf hashes, all hex32-shaped; every obfuscated hash hex32-shaped; total
 *    leaf count (`reservedLeafHashes.length + disclosed.length + obfuscatedLeafHashes.length`) does
 *    not exceed 64; `root` hex32-shaped.
 * 2. No disclosed leaf names a reserved owner-control keyPath (`owner.*` outside `owner.identity.*`).
 *    No two disclosed leaves recompute to the same keyPath field (no duplicates). (No keyPath is
 *    required to be present - see the file header's non-maskable-set finding.)
 * 3. EVERY disclosed leaf hash is recomputed from its posted opening - a posted hash is never
 *    trusted, because there is none to trust: the wire shape carries openings, not hashes. A
 *    recomputed disclosed hash must never equal an obfuscated or reserved hash (overlap - mirrors
 *    `checkIntegrity`'s live-vs-obfuscated overlap check in verify.ts).
 * 4. The sorted, commutative Merkle root over `[3 reserved] + [obfuscated] + [N disclosed]` equals
 *    `root`.
 *
 * Step 5 of the plan (`profileRoot(dogTagIdField) == root`, `rootIssuer` resolution, `isValid` on
 * the issuer clone) is deliberately NOT this pure function's job - it needs chain reads and belongs
 * with the caller, exactly as `verify()`'s on-chain reads sit apart from `checkIntegrity` in verify.ts.
 *
 * The OPTIONAL `opts.expectedIdentityLeaves` cross-check, when supplied, additionally requires the
 * `owner.identity.*` subset of the recomputed disclosed leaves to equal it as an exact multiset - no
 * missing, extra, duplicate, or altered identity leaf, exactly like `verifyLeafCommitment`'s
 * (mandatory) version of the same check.
 */
export declare function verifyRedactedArtifact(artifact: RedactedTagArtifact, opts?: VerifyRedactedArtifactOpts): boolean;
//# sourceMappingURL=redactedArtifact.d.ts.map