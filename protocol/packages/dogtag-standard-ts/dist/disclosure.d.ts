import { type TypeTag } from "./types.js";
/** One revealed leaf: the full opening plus its root-ward `Sibling | Promote` inclusion proof, wire
 * encoded as one string per step: `"promote"` or a `0x..` 32-byte sibling hex. */
export interface ProfileDisclosureEntry {
    keyPath: string;
    saltHex: string;
    tag: TypeTag;
    value: string;
    proof: string[];
}
/** The disclosure envelope: `{dogTagId, R, disclosures: [...]}`. `dogTagId` is the canonical
 * dogTagId field (see `dogTagIdField` in `./profileBind.js`) as `0x..` 32-byte hex - the on-chain
 * `profileRoot` key and the consent proof's `pub[0]`, never the raw decimal handle. This pure
 * verifier does not consume it; the caller binds it to the accompanying consent proof and to the
 * on-chain anchor. */
export interface ProfileDisclosure {
    dogTagId: string;
    R: string;
    disclosures: ProfileDisclosureEntry[];
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
export declare function verifyProfileDisclosure(d: ProfileDisclosure): boolean;
//# sourceMappingURL=disclosure.d.ts.map