import { type Field } from "./field.js";
import { TypeTag } from "./types.js";
/** One opened attribute leaf as posted by the owner's app at bind time. */
export interface OpenedLeaf {
    keyPath: string;
    saltHex: string;
    tag: TypeTag;
    value: string;
}
export interface VerifyLeafCommitmentInput {
    /** The `0x..` 32-byte root the owner's app claims for this tag (what the vet is about to seal
     * into `profileRoot(dogTagId)` via `issueTag`). */
    root: string;
    /** Every opened (non-reserved) leaf the owner's app is disclosing at bind time: pet attributes
     * plus the `owner.identity.*` openings. */
    leaves: OpenedLeaf[];
    /** The three reserved owner-control leaf hashes (`owner.address`, `owner.consentKey`,
     * `owner.secret`), as opaque `0x..` hashes - the vet cannot recompute these, they commit to
     * owner secrets that never leave the device. Must be exactly 3. */
    reservedLeafHashes: string[];
    /** The identity openings the vet's own attested record expects to see under `owner.identity.*` -
     * the posted openings must equal this SET exactly: no missing, extra, duplicate, or altered entry. */
    expectedIdentityLeaves: OpenedLeaf[];
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
export declare function verifyLeafCommitment(input: VerifyLeafCommitmentInput): boolean;
/**
 * `dogTagIdField(handleDec)` - the canonical on-chain dogTagId field: `bytesToField(utf8(
 * canonicalInteger(handleDec)))`, composed exactly as the Rust `field_of_value(Integer(handle))`
 * (parity-pinned against `crates/dogtag-standard-rs/src/bin/field-hash.rs`; see
 * `test/profile_bind.test.ts` for the cross-language fixture). This is the value the SBT is minted
 * with, the consent circuit's `pub[0]`, and the key `DogTagSBTConsent.profileRoot(dogTagId)` is
 * stored under - never the raw decimal handle a vet operator types into the mint form.
 */
export declare function dogTagIdField(handleDec: string): Field;
//# sourceMappingURL=profileBind.d.ts.map