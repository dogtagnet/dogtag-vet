/** Mandatory type tag so `"5"` (string) != `5` (integer). impl §1.1 / §3.2. */
export declare enum TypeTag {
    Null = 0,
    Bool = 1,
    String = 2,
    Integer = 3,
    Decimal = 4,
    Bytes = 5
}
/** A single typed scalar entering the wrap boundary (typed input — A2; never a native float). */
export type TypedScalar = {
    tag: TypeTag.Null;
    value: null;
} | {
    tag: TypeTag.Bool;
    value: boolean;
} | {
    tag: TypeTag.String;
    value: string;
} | {
    tag: TypeTag.Integer;
    value: string;
} | {
    tag: TypeTag.Decimal;
    value: string;
} | {
    tag: TypeTag.Bytes;
    value: Uint8Array;
};
export interface IssuerMeta {
    name: string;
    domain: string;
    documentStore: string;
    recordType: string;
}
/**
 * M7 record-provenance block (§4.2), mirror of the Rust `ProtocolMeta`: which protocol/contract a
 * record was created on AND who issued it, carried BESIDE `signature.merkleRoot` - NEVER inside `R`
 * or the ZK proof. A routing hint only, never authority: `issuerSigner` is the envelope's *claim*,
 * validated against the on-chain `clone.issuedBy[R]` at verify time.
 */
export interface ProtocolMeta {
    chainId: number;
    version: string;
    verificationRegistry: string;
    issuerClone: string;
    issuerSigner: string;
    /**
     * A REACHABLE origin (scheme + host [+ port]) serving this issuer's public, PII-free receipt status
     * page at `<statusBaseUrl>/r/<receiptId>` - stamped by the issuing stack from its `DEPLOYMENT_URL`.
     * Absent when the issuer publishes no such page.
     *
     * `issuer.domain` is NOT this: it is a `did:web` IDENTITY, a stable name that need not resolve and
     * need not serve anything (the shipped default `gov.example` is RFC-2606 reserved, hence NXDOMAIN).
     * Renderers MUST use this field and MUST NOT fall back to `issuer.domain`; with no value there is
     * no status page, and saying so is the honest degradation.
     *
     * Outside the Merkle root like the rest of this block, so stamping it disturbs no anchored `R`.
     */
    statusBaseUrl?: string;
}
export interface WrappedDoc {
    version: "dogtag/1.0";
    data: unknown;
    signature: {
        type: "DogTagMerkleProof";
        targetHash: string;
        proof: string[];
        merkleRoot: string;
    };
    privacy: {
        obfuscated: string[];
    };
    issuer: IssuerMeta;
    protocol?: ProtocolMeta;
}
/**
 * The `owner.` namespace is RESERVED for owner-control profile-tree leaves (current and future);
 * `owner.identity.*` is the one sanctioned carve-out, for vet-attested human-identity attribute
 * leaves (D1). Mirrors `dogtag-standard-rs::profile_tree::{OWNER_NAMESPACE_PREFIX,
 * OWNER_IDENTITY_PREFIX}`. Shared by `disclosure.ts` and `profileBind.ts` so the two surfaces that
 * police this boundary cannot drift apart on the literal.
 */
export declare const OWNER_NAMESPACE_PREFIX = "owner.";
export declare const OWNER_IDENTITY_PREFIX = "owner.identity.";
/** 4-state fragment result (impl §11.3). */
export type FragmentState = "VALID" | "INVALID" | "ERROR" | "NOT_APPLICABLE";
/**
 * The factory-anchored issuer-whitelist pillar's outcome (impl §11.3, C7 parity with
 * `dogtag-standard-rs::verify::IssuerWhitelistState`). Deliberately not a boolean: "not evaluated"
 * and "evaluated and passed" must never collapse into the same wire value.
 *
 * Only PASSED (or this verifier's own gap, UNAVAILABLE_NO_FACTORY_CONFIGURED) may contribute to a
 * pass - see {@link issuerWhitelistPermitsPass}. FAILED and UNRESOLVED both gate the verdict, for
 * different reasons: FAILED is evidence about the credential, UNRESOLVED is a question that could
 * not be answered either way.
 */
export type IssuerWhitelistState = "PASSED" | "FAILED" | "UNRESOLVED" | "UNAVAILABLE_NO_FACTORY_CONFIGURED";
/** May this issuer-whitelist state contribute to a pass? Only a definite PASSED does, plus the one
 * case that is this verifier's own gap rather than evidence about the credential. */
export declare function issuerWhitelistPermitsPass(s: IssuerWhitelistState): boolean;
/**
 * Whether the document's own `issuer.documentStore` agrees with the clone this verifier's OWN
 * factory named for the root. A separate term from {@link IssuerWhitelistState}: naming the wrong
 * contract and employing an unauthorised signer are different accusations with different remedies.
 */
export type IssuerStoreAgreement = "MATCHED" | "DIFFERS" | "NOT_EVALUATED";
/** May this term contribute to a pass? Only a definite DIFFERS refuses. */
export declare function issuerStorePermitsPass(s: IssuerStoreAgreement): boolean;
/** How {@link Verdict.issuerAddr} was arrived at - a caller must be able to tell "not evaluated"
 * from "evaluated and passed", so it is reported explicitly rather than left implicit. */
export type IssuerResolution = "RESOLVED" | "NO_RECORD" | "NO_FACTORY_CONFIGURED" | "READ_FAILED";
/** What this verifier's OWN factory answered for a root - the adapter-facing anchor result. */
export type IssuerAnchor = {
    kind: "resolved";
    clone: string;
} | {
    kind: "noRecord";
} | {
    kind: "noFactoryConfigured";
};
/**
 * Did the issuing signer hold the capability AT THE MOMENT this root was anchored? Reconstructed
 * from the governing authority's grant-history log, never from a current-state read - delisting is
 * forward-only, so a current-state predicate would refuse every credential a since-rotated signer
 * ever issued.
 */
export type GrantAtIssuance = "AUTHORIZED" | "NOT_AUTHORIZED" | "UNDETERMINED";
/** A point in a log stream, ordered by (blockNumber, logIndex) - block-scoped, so comparable
 * across contracts within one block. */
export interface LogPoint {
    blockNumber: number;
    logIndex: number;
}
/** One `Whitelisted`/`Delisted` grant-history event, as observed in the governing registry's log. */
export interface GrantEvent {
    at: LogPoint;
    granted: boolean;
}
export interface Verdict {
    valid: boolean;
    fragments: {
        integrity: FragmentState;
        issuance: FragmentState;
        identity: FragmentState;
        ownership: FragmentState;
    };
    /** The factory-anchored issuer-whitelist pillar (MANDATORY: see {@link issuerWhitelistPermitsPass}). */
    issuerWhitelist: IssuerWhitelistState;
    /** Whether `issuer.documentStore` names the clone this verifier's factory resolved. */
    issuerStore: IssuerStoreAgreement;
    /** How {@link Verdict.issuerAddr} was arrived at. */
    issuerResolution: IssuerResolution;
    /** The clone the on-chain reads were actually made against. */
    issuerAddr: string;
}
//# sourceMappingURL=types.d.ts.map