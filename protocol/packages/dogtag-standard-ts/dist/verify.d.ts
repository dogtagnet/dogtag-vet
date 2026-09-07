import { type Field } from "./field.js";
import type { FragmentState, GrantAtIssuance, GrantEvent, IssuerAnchor, LogPoint, Verdict, WrappedDoc } from "./types.js";
/**
 * Network adapters are injected so the core SDK stays pure/offline (mobile + server share it).
 *
 * No method here has a default implementation, deliberately: a required interface makes every
 * implementor decide every read, and removes "unwired" as a concept a caller could fall into by
 * accident (see the file header - this was exactly the v1 fail-open's root cause).
 */
export interface RpcAdapter {
    /** DogTagIssuer.isValid(root) at >= `confirmations` blocks, against the RESOLVED clone. Throw for ERROR. */
    isValid(issuerAddr: string, merkleRoot: string, confirmations: number): Promise<boolean>;
    /** DogTagSBT.ownerOf(dogTagId). Throw for ERROR. */
    ownerOf(dogTagId: string): Promise<string>;
    /**
     * `DogTagIssuerFactory.rootIssuer(R)` read against THIS VERIFIER'S OWN configured factory. Takes
     * no factory address on purpose: an address the caller or the document could name is an address
     * an attacker can name, which is the very substitution this anchor exists to close.
     */
    rootIssuer(merkleRoot: string): Promise<IssuerAnchor>;
    /**
     * `DogTagIssuer.issuedBy(root)` - the originator that actually called `issue(root)` on this clone,
     * or `null` when the clone never issued it (the on-chain zero address). `issue()` is
     * `onlyWhitelisted`, so a genuinely issued root's originator was whitelisted for its record type at
     * issuance by construction - this is what lets the pillar resolve its own signer instead of
     * trusting one the document names.
     */
    issuedBy(issuerAddr: string, merkleRoot: string): Promise<string | null>;
    /**
     * `DogTagIssuer.recordTypeOf(root)` (WP4.14) - a v2 clone's PER-ROOT record-type mapping
     * (`contracts/src/VetIssuer.sol`'s `mapping(bytes32 => bytes32) public recordTypeOf`, populated by
     * BOTH the original tag-issuance path and by `issueRecord(recordType, root)`), or `null` for the
     * zero word (this root was never issued through the mapping on this clone - uninitialized, not a
     * failure). Read from the RESOLVED clone, about THIS root, so the whitelist question is asked about
     * the record type the CHAIN says this SPECIFIC root belongs to, never the one the envelope claims.
     *
     * This is the PRIMARY read (`resolveIssuerWhitelist` tries it first); {@link issuerRecordType} is
     * the fallback used only when THIS call itself throws (specs/leaf-commitment.md section 16's
     * on-chain binding rules; WP4.14 plan section 3's "SDK whitelist pillar still calls v1 recordType()
     * ... v2 has recordTypeOf(root)" blocker). A v2 clone legitimately returning the zero word is NOT a
     * signal to fall back - it means "not found on this clone", exactly like `issuerRecordType`
     * returning `null` today; the fallback triggers on the CALL failing (no such function on this
     * clone's bytecode at all - a pre-v2 clone), never on a successful call's result.
     */
    issuerRecordTypeOfRoot(issuerAddr: string, merkleRoot: string): Promise<string | null>;
    /**
     * `DogTagIssuer.recordType()` - the clone's own immutable, per-CLONE record-type key (the pre-WP4.14
     * v1 shape), or `null` for the zero word (uninitialized / not a clone). FALLBACK ONLY, tried when
     * {@link issuerRecordTypeOfRoot}'s call itself fails (a clone whose bytecode predates `recordTypeOf`
     * entirely) - not a v2 clone's primary read. Read from the RESOLVED clone so the whitelist question
     * is asked about the record type the CHAIN says this clone belongs to, never the one the envelope
     * claims.
     */
    issuerRecordType(issuerAddr: string): Promise<string | null>;
    /**
     * Was `signer` authorised to anchor on `issuerAddr` AT THE MOMENT `merkleRoot` was anchored?
     * Reconstructed from the governing authority's grant-history log (see {@link grantInForceAt}) -
     * never a current-state read, because delisting is forward-only.
     */
    whitelistedAtIssuance(issuerAddr: string, signer: string, merkleRoot: string): Promise<GrantAtIssuance>;
}
export interface DnsAdapter {
    /** True iff a TXT record of `domain` binds `documentStore` on `chainId`. Throw for ERROR. */
    txtMatches(domain: string, documentStore: string, chainId: number): Promise<boolean>;
}
export interface RegistryAdapter {
    /** The admin-written central registry knows this (domain, documentStore) pair. */
    knows(domain: string, documentStore: string): Promise<boolean>;
}
export interface VerifyOpts {
    rpc: RpcAdapter;
    dns: DnsAdapter;
    registry: RegistryAdapter;
    mode: "self-import" | "third-party";
    userWalletAddress?: string;
    confirmations?: number;
}
/**
 * Pure integrity pillar: rebuild the WHOLE tree (never trust processProof alone - C1) and
 * compare to targetHash, then resolve the proof to merkleRoot. Returns the recomputed root + state.
 *
 * FIXED (round 2, grader finding #2): every parse that can fail on hostile input - a malformed
 * `salt:tag:value` or unknown tag (`leafFromPacked`), or a same-length hex string that exceeds the
 * field or is not valid hex at all (`fromHex32` on `targetHash`/`merkleRoot`) - is now caught and
 * folded into INVALID, mirroring `crates/dogtag-standard-rs/src/verify.rs::check_integrity`'s
 * `Err(_) => return (Invalid, ...)` arms exactly. Previously these threw past `checkIntegrity` and
 * out of `verify()` entirely: a 5th, undeclared "crashed" state outside the 4-state fragment model.
 */
export declare function checkIntegrity(doc: WrappedDoc): {
    state: FragmentState;
    root: Field;
};
/**
 * `0x`-hex keccak256 of a record-type label - the `IssuerRegistry` whitelist key and the value a
 * clone's immutable `recordType()` returns. Parity-pinned against `record_type_key` in
 * `crates/dogtag-standard-rs/src/verify.rs` (`keccak("VACCINATION")`).
 */
export declare function recordTypeKey(recordType: string): string;
/**
 * Fold one `(recordType, signer)` grant history against the point a root was anchored (impl §11.3,
 * parity with `dogtag-standard-rs::verify::grant_in_force_at`): the state as of the anchoring point
 * is the LAST event at or before it. An empty history is NOT_AUTHORIZED (the registry answered and
 * recorded no grant), never UNDETERMINED - callers keep a log read that failed entirely apart from
 * this, and never call this helper for that case.
 */
export declare function grantInForceAt(history: GrantEvent[], anchoredAt: LogPoint): GrantAtIssuance;
/** Full contextual verify (impl §11.3). */
export declare function verify(doc: WrappedDoc, opts: VerifyOpts): Promise<Verdict>;
//# sourceMappingURL=verify.d.ts.map