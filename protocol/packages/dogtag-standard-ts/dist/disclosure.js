// `ProfileDisclosure` - the additive selective-disclosure envelope for profile-tree attribute leaves
// (D1; parity with `crates/dogtag-standard-rs/src/disclosure.rs`).
//
// The profile tree has no document envelope at all - only `R` ever leaves the device - so disclosure
// here starts from nothing and adds `(keyPath, saltHex, tag, value, proof)` tuples for exactly the
// leaves the owner chose. A disclosure is cryptographically INDEPENDENT of the consent proof; they
// share only `R`. The consent circuit is leaf-blind and frozen - nothing here touches it.
//
// This module is VERIFICATION ONLY: building a disclosure (walking the owner's local tree and
// picking a `Sibling | Promote` path per revealed leaf) stays mobile-side, next to the on-device
// tree builder. What verifies here is the PURE half - per-entry `verifyInclusion` folding to `R`.
// The on-chain anchor half - `R == profileRoot(dogTagId)` and `rootIssuer[R]` resolving to a trusted
// issuer with `isValid(R)` - needs chain reads and lives with the caller (the vet/relayer backend).
import { nfc, hexToBytes } from "./encode.js";
import { verifyInclusion } from "./merkle.js";
import { fromHex32 } from "./field.js";
import { scalarFromPacked } from "./wrap.js";
import { OWNER_IDENTITY_PREFIX, OWNER_NAMESPACE_PREFIX } from "./types.js";
/**
 * Reject a keyPath the disclosure surface must never carry: the owner-CONTROL namespace (anything
 * under `owner.` outside `owner.identity.`). Those leaves are reserved-encoded and structurally
 * undisclosable through {@link verifyInclusion} anyway - a reserved leaf's hash can never be
 * reproduced by `hashLeaf` - but refusing them by NAME fails loudly instead of silently returning
 * false.
 */
function rejectOwnerControl(keyPath) {
    const normalized = nfc(keyPath);
    if (normalized.startsWith(OWNER_NAMESPACE_PREFIX) && !normalized.startsWith(OWNER_IDENTITY_PREFIX)) {
        throw new Error(`keyPath ${JSON.stringify(keyPath)} is an owner-control leaf and can never be disclosed`);
    }
}
function parseProofSteps(steps) {
    return steps.map((s) => (s.toLowerCase() === "promote" ? { promote: true } : { sibling: fromHex32(s) }));
}
/**
 * Verify the PURE half of a {@link ProfileDisclosure}: every entry's leaf, RECOMPUTED from its
 * `(keyPath, salt, tag, value)` opening under `DS_LEAF` (never trusting a caller-supplied hash),
 * must fold through its proof to the envelope's `R`.
 *
 * Throws on a malformed envelope: empty disclosure list, an owner-control keyPath, a duplicate
 * keyPath, bad salt hex, or an unknown tag - a malformed request fails loudly rather than reading
 * as an honest `false`. Returns `false` (never throws) when a well-formed entry simply does not
 * fold to `R` - a tampered value, a tampered proof, or the wrong root.
 *
 * Callers MUST additionally bind the envelope: `R == profileRoot(dogTagId)` on-chain,
 * `rootIssuer[R]` resolving to a trusted issuer with `isValid(R)`, and - when presented alongside a
 * consent proof - `R == pub[4]` and `dogTagId == pub[0]` of that proof.
 */
export function verifyProfileDisclosure(d) {
    if (d.disclosures.length === 0) {
        // A vacuous envelope must never read as "verified".
        throw new Error("disclosures must not be empty");
    }
    const root = fromHex32(d.R);
    const seen = new Set();
    for (const entry of d.disclosures) {
        rejectOwnerControl(entry.keyPath);
        const normalized = nfc(entry.keyPath);
        if (seen.has(normalized)) {
            throw new Error(`duplicate disclosed keyPath ${JSON.stringify(entry.keyPath)}`);
        }
        seen.add(normalized);
        const salt = hexToBytes(entry.saltHex);
        const scalar = scalarFromPacked(entry.tag, entry.value);
        const steps = parseProofSteps(entry.proof);
        if (!verifyInclusion(entry.keyPath, salt, scalar, steps, root))
            return false;
    }
    return true;
}
//# sourceMappingURL=disclosure.js.map