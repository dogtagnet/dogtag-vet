// RecordArtifact - selective disclosure BY OBFUSCATION over a RECORD's own opened-leaf tree, with NO
// reserved owner-control leaves (WP4.14, specs/leaf-commitment.md section 16). The sibling of
// redactedArtifact.ts's RedactedTagArtifact, which is built over a device's PROFILE tree instead - a
// tree that always folds in the three reserved owner-control leaves (section 9) and whose identity
// anchor (dogTagIdField) lives OUTSIDE the tree because the chain binds it separately
// (profileRoot(dogTagIdField) == root). A record's on-chain anchor is issueRecord(recordType, root)
// instead - a root-keyed anchor with no owner-control material folded into it, ever - so this format's
// policy differs from RedactedTagArtifact's on every axis section 16 enumerates: reserved leaves
// (always empty, not always 3), the non-maskable set (exactly 7 keyPaths, by Kenneth's decision, not
// none by evidence), and the 64-leaf cap (does not apply - section 10 ties that cap to the frozen
// depth-6 consent circuit's witness shape, and a record is never consent-proven).
//
// `verifyRecordArtifact` is, like `verifyRedactedArtifact`, a pure COMPOSITION of the two frozen
// primitives every other verifier in this package is built from - `hashLeaf` (recompute a disclosed
// leaf from its opening) and `buildMerkle` (fold the full leaf set back to the root) - plus the same
// reserved-owner-namespace guard `verifyLeafCommitment`/`verifyRedactedArtifact` already enforce. It
// adds no new hashing, encoding, or tree-construction rule of its own. `recomputeLeaf` below is
// intentionally a THIRD independent transcription of profileBind.ts's/redactedArtifact.ts's private
// helper of the same name (composed entirely from already-exported primitives), not a shared import -
// see redactedArtifact.ts's own file header for why this repository prefers a deliberate second (here,
// third) transcription over a shared import for this class of code: each file's tests fully pin its
// own behavior, and a future drift between the transcriptions is exactly what a cross-file equivalence
// test would catch, the same way redactedArtifact.test.ts already does against profile_bind.test.ts's
// fixtures.
//
// NON-MASKABLE keyPaths: EXACTLY SEVEN, by Kenneth's decision (WP4.14 plan section 10, confirmed
// round 2 item 5 and round 3) - the opposite finding from RedactedTagArtifact's "none, by evidence"
// (redactedArtifact.ts's own header). `credentialSubject.dogTagId`, `recordType`,
// `credentialSchema.id`, `credentialSchema.version`, `issuer.chainId`, `issuer.contract`,
// `issuer.operator` MUST each be a fully opened entry in `disclosed`, or verification fails - see
// specs/leaf-commitment.md section 16 for the rationale behind each. Owner data is never a member of
// this set, and under the WP4.14 leaf list never appears in a record's leaf set at all.
import { hashLeaf, fieldOfKeyPath } from "./leaf.js";
import { encodeValue, hexToBytes, nfc } from "./encode.js";
import { buildMerkle } from "./merkle.js";
import { fromHex32, toHex32 } from "./field.js";
import { scalarFromPacked } from "./wrap.js";
import { OWNER_IDENTITY_PREFIX, OWNER_NAMESPACE_PREFIX } from "./types.js";
/**
 * The seven keyPaths every valid {@link RecordArtifact} MUST disclose (specs/leaf-commitment.md
 * section 16). Exported so a caller (or a test) can enumerate the set without duplicating it.
 */
export const RECORD_NON_MASKABLE_KEY_PATHS = [
    "credentialSubject.dogTagId",
    "recordType",
    "credentialSchema.id",
    "credentialSchema.version",
    "issuer.chainId",
    "issuer.contract",
    "issuer.operator",
];
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
function isHex32(h) {
    return HEX32.test(h);
}
/** Fix round 1 D2 (grade wp4.14S-grade.md): true if `saltHex` contains anything `hexToBytes` (frozen,
 * `encode.ts`) would silently MISHANDLE rather than reject. `hexToBytes` decodes byte-pair-by-byte-pair
 * via `parseInt(..., 16)`, which returns `NaN` for a non-hex pair - a `Uint8Array` store then coerces
 * that `NaN` to `0`, so a non-hex-but-even-length `saltHex` silently becomes a wrong-but-16-byte salt
 * instead of throwing. Rust's `hex::decode` (`record_artifact.rs`/`redacted_artifact.rs`) errors on the
 * identical input. `hexToBytes`'s own odd-length check already throws correctly (matching Rust) and
 * needs no help here; this guard is checked anyway, defensively, so the combined condition matches
 * `hex::decode`'s error surface exactly rather than relying on two different code paths to agree. */
function isMalformedSaltHex(saltHex) {
    const s = saltHex.startsWith("0x") ? saltHex.slice(2) : saltHex;
    return !/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0;
}
/** Recompute one disclosed leaf's hash from its posted opening. Throws on a malformed opening (bad
 * salt hex/length, unknown tag, bad value encoding) - `verifyRecordArtifact` catches this and rejects
 * rather than propagate it, keeping the check fail-closed either way. Third independent transcription
 * of the same-named helper in profileBind.ts/redactedArtifact.ts - see this file's header. */
function recomputeLeaf(leaf) {
    if (isMalformedSaltHex(leaf.saltHex)) {
        throw new Error("saltHex contains a non-hex character or odd length (fix round 1 D2)");
    }
    const salt = hexToBytes(leaf.saltHex);
    const scalar = scalarFromPacked(leaf.tag, leaf.value);
    // encodeValue is called only to force a malformed value (e.g. a non-canonical integer) to throw
    // here rather than inside hashLeaf with a less specific stack, matching hashLeaf's own encoding.
    encodeValue(scalar);
    return hashLeaf(leaf.keyPath, salt, scalar);
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
export function verifyRecordArtifact(artifact) {
    try {
        const { root, disclosed, obfuscatedLeafHashes, reservedLeafHashes } = artifact;
        if (reservedLeafHashes.length !== 0)
            return false;
        if (!obfuscatedLeafHashes.every(isHex32))
            return false;
        if (!isHex32(root))
            return false;
        const credentialSchemaIdField = fieldOfKeyPath("credentialSchema.id");
        const seenKeyPathFields = new Set();
        const disclosedHashes = [];
        const disclosedKeyPathFields = new Set();
        let disclosedSchemaId;
        for (const leaf of disclosed) {
            const normalized = nfc(leaf.keyPath);
            if (normalized.startsWith(OWNER_NAMESPACE_PREFIX) && !normalized.startsWith(OWNER_IDENTITY_PREFIX)) {
                return false; // an owner-control keyPath posing as a disclosed attribute
            }
            const kpField = fieldOfKeyPath(leaf.keyPath);
            if (seenKeyPathFields.has(kpField))
                return false; // duplicate disclosed keyPath
            seenKeyPathFields.add(kpField);
            disclosedKeyPathFields.add(kpField);
            if (kpField === credentialSchemaIdField)
                disclosedSchemaId = leaf.value;
            disclosedHashes.push(recomputeLeaf(leaf));
        }
        // Non-maskable-set check - MUST run before the Merkle fold below (see doc comment step 3).
        for (const required of RECORD_NON_MASKABLE_KEY_PATHS) {
            if (!disclosedKeyPathFields.has(fieldOfKeyPath(required)))
                return false;
        }
        // Step 3b: schemaId, when present, must agree with the disclosed credentialSchema.id leaf it
        // mirrors - the non-maskable check above guarantees disclosedSchemaId is defined here.
        if (artifact.schemaId !== undefined && artifact.schemaId !== disclosedSchemaId)
            return false;
        const obfuscatedFields = obfuscatedLeafHashes.map(fromHex32);
        // overlap rejection: a disclosed leaf hash must never equal an obfuscated hash.
        const opaque = new Set(obfuscatedFields);
        for (const h of disclosedHashes) {
            if (opaque.has(h))
                return false;
        }
        // disclosedHashes is never empty here (the non-maskable check above guarantees at least 7
        // entries), so buildMerkle's input is never empty either.
        const { root: computedRoot } = buildMerkle([...obfuscatedFields, ...disclosedHashes]);
        return toHex32(computedRoot) === root.toLowerCase();
    }
    catch {
        return false; // any parse failure on a malformed/hostile payload is a rejection
    }
}
//# sourceMappingURL=recordArtifact.js.map