import type { OpenedLeaf } from "./profileBind.js";
/**
 * The seven keyPaths every valid {@link RecordArtifact} MUST disclose (specs/leaf-commitment.md
 * section 16). Exported so a caller (or a test) can enumerate the set without duplicating it.
 */
export declare const RECORD_NON_MASKABLE_KEY_PATHS: readonly string[];
/**
 * The wire format (WP4.14 plan section 4, specs/leaf-commitment.md section 16): a `TagArtifact`-
 * shaped custody record over a RECORD's own opened-leaf tree, with NO reserved owner-control leaves.
 * Deliberately carries no `dogTagIdField`/`dogTagIdDec`/`issuerClone`/top-level `recordType` field,
 * unlike {@link RedactedTagArtifact} - `credentialSubject.dogTagId`, `issuer.contract`, and
 * `recordType` are each already non-maskable disclosed leaves on every valid record artifact, so a
 * second, unchecked top-level copy of any of them would only invite drift between what is shown and
 * what the root commits to (specs/leaf-commitment.md section 16's wire-format note). A caller reads
 * any of these three straight out of `disclosed` once {@link verifyRecordArtifact} has returned `true`.
 */
export interface RecordArtifact {
    protocolVersion: string;
    /** Wire-format discriminator distinguishing this shape from a {@link RedactedTagArtifact} (whose
     * legacy wire payloads carry no `artifactType` at all - absence is read as the implicit `"tag"`
     * case). Not a leaf; not itself cryptographically checked. */
    artifactType: "record";
    /** The schema-registry `$id` this record's record type was issued/received against, e.g.
     * `https://dogtag.io/schemas/vaccination/v1`. Mirrors the disclosed `credentialSchema.id` leaf for
     * a caller's convenience (so it need not decode `disclosed` just to read this) - and, UNLIKE
     * {@link RedactedTagArtifact}'s own `schemaId` field (which has no committed leaf counterpart in a
     * profile tree to diverge from at all), this one DOES have a committed counterpart here, since
     * `credentialSchema.id` is always a non-maskable disclosed leaf on a valid record artifact. So this
     * verifier DOES check it, when present: an artifact whose top-level `schemaId` disagrees with its
     * own disclosed `credentialSchema.id` leaf is rejected outright, rather than left as an unchecked
     * mirror a display bug could silently drift from what the root actually commits to. Optional - a
     * caller with no independent registry-lookup need may omit it entirely and lose nothing. */
    schemaId?: string;
    root: string;
    disclosed: OpenedLeaf[];
    obfuscatedLeafHashes: string[];
    /** MUST be the empty array - a record's tree carries no reserved owner-control leaves at all
     * (specs/leaf-commitment.md section 16). Present (as an always-empty array) rather than omitted so
     * this shape stays structurally parallel to its RedactedTagArtifact sibling. */
    reservedLeafHashes: string[];
}
/**
 * Verify a {@link RecordArtifact}: does `root` really commit to exactly
 * `[obfuscatedLeafHashes] + [disclosed]` (reserved contributes nothing - there are never any), with
 * every disclosed leaf hash RECOMPUTED from its opening (never trusted), no disclosed leaf colliding
 * with an owner-control keyPath, a duplicate keyPath, or an opaque (obfuscated) hash, and every one of
 * the seven non-maskable keyPaths ({@link RECORD_NON_MASKABLE_KEY_PATHS}) genuinely disclosed?
 *
 * Fail-closed by construction, exactly like `verifyRedactedArtifact`: every check below can only turn
 * a `true` into `false`, and any exception thrown while parsing a malformed opening is caught and
 * treated as rejection, never propagated as an ambiguous crash. Checks, in order (specs/leaf-
 * commitment.md section 16):
 *
 * 1. `reservedLeafHashes` is exactly the empty array; every `obfuscatedLeafHashes` entry is
 *    hex32-shaped; `root` is hex32-shaped. (No total-leaf-count bound: section 10's 64-leaf cap is a
 *    consent-bind policy that does not apply to a record, which is never consent-proven.)
 * 2. No disclosed leaf names a reserved owner-control keyPath (`owner.*` outside `owner.identity.*` -
 *    applied here defensively even though a genuinely-built record tree never has one to begin with).
 *    No two disclosed leaves recompute to the same keyPath field.
 * 3. Every one of the seven non-maskable keyPaths is present among disclosed's (NFC-normalized,
 *    field-compared) keyPaths. THIS RUNS BEFORE STEP 5's MERKLE FOLD: it is what guarantees
 *    `disclosed` is never empty by the time `buildMerkle` is called - an artifact posting all three
 *    arrays empty is rejected HERE, before `buildMerkle` ever sees it (the Rust reference
 *    implementation's `build_merkle` panics on an empty slice, and a `RecordArtifact` has no
 *    reserved-triple floor the way a `RedactedTagArtifact` always does).
 * 3b. If the top-level `schemaId` is present, it must equal the disclosed `credentialSchema.id` leaf's
 *     value exactly - the one top-level field this format keeps DOES have a committed counterpart
 *     (unlike `RedactedTagArtifact`'s own `schemaId`), so it is cross-checked rather than left as an
 *     unchecked mirror. Safe to run here: step 3 already guarantees `credentialSchema.id` is disclosed.
 * 4. EVERY disclosed leaf hash is recomputed from its posted opening - a posted hash is never trusted.
 *    A recomputed disclosed hash must never equal an obfuscated hash (overlap - the same rule
 *    `verifyRedactedArtifact` applies, minus the reserved half, since a record artifact never has one).
 * 5. The sorted, commutative Merkle root over `[obfuscated] + [N disclosed]` equals `root`.
 *
 * The on-chain binding rules (`rootIssuer[root] == issuer.contract`, `recordTypeOf(root) ==
 * keccak256(recordType)`, `isValid(root)`, `issuedBy(root) == issuer.operator`, `issuer.chainId`
 * equals the chain) are deliberately NOT this pure function's job - they need chain reads and belong
 * with the caller, exactly as section 15's step 5 sits apart from `verifyRedactedArtifact`.
 */
export declare function verifyRecordArtifact(artifact: RecordArtifact): boolean;
//# sourceMappingURL=recordArtifact.d.ts.map