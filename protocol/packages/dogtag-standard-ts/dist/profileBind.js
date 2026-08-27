// Vet-side bind-commitment check (D1/M5) - the fail-closed mirror of `verify_leaf_commitment` in
// the v1 vet API (`stacks/vet/api/src/routes.rs`, described in `docs/architecture-v2.md`). The vet
// platform runs this against the owner's posted `custodial-bind` payload before it ever calls
// `issueTag` on chain: the tag mints only if the tree the owner built really does commit to the
// vet-attested identity openings, and to nothing else.
//
// This module never trusts a value it did not recompute itself. Every opened leaf hash is rebuilt
// from its `(keyPath, saltHex, tag, value)` opening under `DS_LEAF`; the three reserved owner-control
// leaves are taken as opaque hashes (the vet cannot recompute them - they commit to owner secrets
// that never leave the device) but their COUNT and the total leaf count are bounds-checked; and the
// root is rebuilt from scratch via the same sorted, commutative Merkle fold every other primitive in
// this package uses. `verifyLeafCommitment` never throws for a malformed or hostile payload - a
// parse failure is a rejection, exactly like every other failure mode here.
import { hashLeaf, fieldOfKeyPath } from "./leaf.js";
import { encodeValue, hexToBytes, nfc } from "./encode.js";
import { buildMerkle } from "./merkle.js";
import { bytesToField, fromHex32, toHex32 } from "./field.js";
import { scalarFromPacked } from "./wrap.js";
import { OWNER_IDENTITY_PREFIX, OWNER_NAMESPACE_PREFIX, TypeTag } from "./types.js";
/** The total leaf count a consent-tree bind may never exceed (3 reserved + up to 61 opened, the
 * capacity of the frozen depth-6 consent tree - `MAX_PROFILE_ATTRIBUTES` in
 * `dogtag-standard-rs::profile_tree`). */
const MAX_TOTAL_LEAVES = 64;
const RESERVED_LEAF_COUNT = 3;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
function isHex32(h) {
    return HEX32.test(h);
}
/** Recompute one opened leaf's hash from its posted opening. Throws on a malformed opening (bad
 * salt hex/length, unknown tag, bad value encoding) - callers of {@link verifyLeafCommitment} catch
 * this and reject rather than propagate it, keeping the bind check fail-closed either way. */
function recomputeLeaf(leaf) {
    const salt = hexToBytes(leaf.saltHex);
    const scalar = scalarFromPacked(leaf.tag, leaf.value);
    // encodeValue is called only to force a malformed value (e.g. a non-canonical integer) to throw
    // here rather than inside hashLeaf with a less specific stack, matching hashLeaf's own encoding.
    encodeValue(scalar);
    return hashLeaf(leaf.keyPath, salt, scalar);
}
/** Multiset equality over recomputed field hashes: same length, same values with the same
 * multiplicity, order irrelevant. Comparing on the RECOMPUTED hash (not the raw keyPath string)
 * also gets NFC-alias safety for free - two distinct strings that NFC-fold to the same text commit
 * to the same leaf, and a raw string compare would wave one past as "different". */
function sameMultiset(a, b) {
    if (a.length !== b.length)
        return false;
    const as = [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const bs = [...b].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    return as.every((v, i) => v === bs[i]);
}
/**
 * The vet-side bind-commitment check (D1/M5): does `root` really commit to exactly
 * `[the 3 reserved owner-control leaves] + [leaves]`, with the `owner.identity.*` subset of
 * `leaves` equal to `expectedIdentityLeaves` as a set?
 *
 * Fail-closed by construction: every check below can only turn a `true` into `false`, and any
 * exception thrown while parsing a malformed opening is caught and treated as rejection, never
 * propagated as an ambiguous crash. Checks, in order:
 *
 * 1. Exactly 3 reserved leaf hashes.
 * 2. Total leaf count (`reservedLeafHashes.length + leaves.length`) does not exceed 64 - the frozen
 *    consent tree's capacity.
 * 3. No opened leaf names a reserved owner-control keyPath (`owner.*` outside `owner.identity.*`) -
 *    an attribute posing as a reserved leaf would let a prover aim an inclusion proof at either.
 * 4. No two opened leaves recompute to the same keyPath field (no duplicates).
 * 5. EVERY opened leaf hash is recomputed from its posted opening - a posted hash is never trusted,
 *    because there is none to trust: the wire shape carries openings, not hashes.
 * 6. The `owner.identity.*` subset of the recomputed opened leaves equals `expectedIdentityLeaves`
 *    (also recomputed) as an exact multiset - no missing, extra, duplicate, or altered identity leaf.
 * 7. The sorted, commutative Merkle root over `[3 reserved hashes] + [N recomputed opened hashes]`
 *    equals `root`.
 */
export function verifyLeafCommitment(input) {
    try {
        const { root, leaves, reservedLeafHashes, expectedIdentityLeaves } = input;
        if (reservedLeafHashes.length !== RESERVED_LEAF_COUNT)
            return false;
        if (!reservedLeafHashes.every(isHex32))
            return false;
        if (reservedLeafHashes.length + leaves.length > MAX_TOTAL_LEAVES)
            return false;
        if (!isHex32(root))
            return false;
        const seenKeyPathFields = new Set();
        const recomputed = [];
        const identityHashes = [];
        for (const leaf of leaves) {
            const normalized = nfc(leaf.keyPath);
            if (normalized.startsWith(OWNER_NAMESPACE_PREFIX) && !normalized.startsWith(OWNER_IDENTITY_PREFIX)) {
                return false; // an owner-control keyPath posing as an opened attribute
            }
            const kpField = fieldOfKeyPath(leaf.keyPath);
            if (seenKeyPathFields.has(kpField))
                return false; // duplicate opened keyPath
            seenKeyPathFields.add(kpField);
            const hash = recomputeLeaf(leaf);
            recomputed.push(hash);
            if (normalized.startsWith(OWNER_IDENTITY_PREFIX))
                identityHashes.push(hash);
        }
        const expectedHashes = expectedIdentityLeaves.map(recomputeLeaf);
        if (!sameMultiset(identityHashes, expectedHashes))
            return false;
        const reservedFields = reservedLeafHashes.map(fromHex32);
        const { root: computedRoot } = buildMerkle([...reservedFields, ...recomputed]);
        return toHex32(computedRoot) === root.toLowerCase();
    }
    catch {
        return false; // any parse failure on a malformed/hostile payload is a rejection
    }
}
/**
 * `dogTagIdField(handleDec)` - the canonical on-chain dogTagId field: `bytesToField(utf8(
 * canonicalInteger(handleDec)))`, composed exactly as the Rust `field_of_value(Integer(handle))`
 * (parity-pinned against `crates/dogtag-standard-rs/src/bin/field-hash.rs`; see
 * `test/profile_bind.test.ts` for the cross-language fixture). This is the value the SBT is minted
 * with, the consent circuit's `pub[0]`, and the key `DogTagSBTConsent.profileRoot(dogTagId)` is
 * stored under - never the raw decimal handle a vet operator types into the mint form.
 */
export function dogTagIdField(handleDec) {
    return bytesToField(encodeValue({ tag: TypeTag.Integer, value: handleDec }));
}
//# sourceMappingURL=profileBind.js.map