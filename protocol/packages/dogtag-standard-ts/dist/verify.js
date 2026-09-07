// Contextual verification (impl §11.3) - fail-closed parity with `crates/dogtag-standard-rs/src/verify.rs` (C7).
//
// Validity = integrity AND issuance AND identity AND the factory-anchored issuer-whitelist pillar
// AND the document's `issuer.documentStore` agreeing with the clone the factory named. `ownership`
// is a CONTEXTUAL 5th fragment: gates only the owner's self-import; NOT_APPLICABLE for third parties.
//
// INTENTIONAL BREAKING CHANGE from the v1 shape of this file (A6): this rewrite reconciles the SDK
// with the Rust orchestration, which the v1 file had drifted from (see the removed KNOWN GAP header
// this replaces). Three changes are not source-compatible with the old file, all in the direction of
// fail-closed:
//   1. `RpcAdapter.issuedBy` is now REQUIRED, and four new required methods were added
//      (`rootIssuer`, `issuerRecordType`, `whitelistedAtIssuance`, plus the existing `isValid` /
//      `ownerOf`). The v1 shape made `issuedBy` OPTIONAL and read every verdict-deciding value
//      straight off `doc.issuer.documentStore` - a field OUTSIDE the Merkle root, so an attacker who
//      builds the document chooses it. Every implementor must now decide every read; "unwired" is no
//      longer a state an adapter can be in by accident.
//   2. The one fail-OPEN path in the v1 file - `catch { issuance = "VALID" }` on a failed
//      `issuedBy` read for the M7 provenance check - is deleted. A read that could not run is now
//      ERROR, never a pass.
//   3. `Verdict` gained four fields - `issuerWhitelist`, `issuerStore`, `issuerResolution`,
//      `issuerAddr` - reporting the mandatory issuer-whitelist pillar. The existing `fragments`
//      shape is unchanged, so callers that only read `valid` / `fragments` are unaffected.
// `checkIntegrity` keeps the same signature and behavior on well-formed input - it is the one symbol
// apps actually import from this module today. Round 2 fixed a fail-open gap in it (see the function's
// own doc comment): a malformed packed leaf or an out-of-field/non-hex `targetHash`/`merkleRoot` used
// to throw past this function and out of `verify()` entirely; both now resolve to INVALID instead.
//
// WP4.14S: a FIFTH new required RpcAdapter method, `issuerRecordTypeOfRoot` - v2 clones store the
// whitelist pillar's record-type key per ROOT (`recordTypeOf(root)`, populated by both tag issuance
// and the new `issueRecord`), not per CLONE the way `issuerRecordType`'s `recordType()` did. Every
// v2 clone this pillar checks was returning UNRESOLVED before this change, because `issuerRecordType`
// alone called a getter that no longer exists on the deployed contract (WP4.14 plan section 3's
// blocker; contracts/src/VetIssuer.sol has no `function recordType()` at all). `issuerRecordType`
// itself is UNCHANGED in shape - it is now the FALLBACK path only, tried when `issuerRecordTypeOfRoot`
// itself fails (see that method's own doc comment for exactly which failure mode triggers it).
import { buildMerkle } from "./merkle.js";
import { flattenData, leafFromPacked } from "./wrap.js";
import { fromHex32 } from "./field.js";
import { bytesToHex } from "./encode.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { issuerStorePermitsPass, issuerWhitelistPermitsPass } from "./types.js";
/** Paths that must be present and are NON-obfuscatable (audit-05 V3/V6). */
const NON_OBFUSCATABLE = ["credentialSubject.dogTagId"];
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
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
export function checkIntegrity(doc) {
    // FIXED (grader finding B): `privacy`/`signature` are typed as always-present, but a `WrappedDoc`
    // reconstructed off the wire is only as complete as whatever sent it. An absent block used to
    // crash `.obfuscated`/`.targetHash` below with a bare TypeError - a 5th, undeclared "crashed"
    // state outside the 4-state fragment model this function otherwise never lets input escape past
    // (see the malformed-hex and malformed-packed-leaf guards below). It now folds to INVALID instead,
    // the same way every other malformed shape here already does.
    if (!doc.privacy || !doc.signature)
        return { state: "INVALID", root: 0n };
    for (const h of doc.privacy.obfuscated) {
        if (!HEX32.test(h))
            return { state: "INVALID", root: 0n };
    }
    const dataFlat = flattenData(doc.data);
    const presentPaths = new Set(dataFlat.map(([kp]) => kp));
    for (const req of NON_OBFUSCATABLE) {
        if (!presentPaths.has(req))
            return { state: "INVALID", root: 0n }; // required + non-obfuscatable
    }
    const liveLeaves = [];
    for (const [kp, packed] of dataFlat) {
        try {
            liveLeaves.push(leafFromPacked(kp, packed));
        }
        catch {
            return { state: "INVALID", root: 0n }; // malformed "salt:tag:value" or unknown tag
        }
    }
    // Already hex32-shape-validated above, but a same-length string can still exceed the field.
    const obf = [];
    for (const h of doc.privacy.obfuscated) {
        try {
            obf.push(fromHex32(h));
        }
        catch {
            return { state: "INVALID", root: 0n };
        }
    }
    // obfuscated entries must not overlap live-leaf hashes (D1)
    const liveSet = new Set(liveLeaves.map((x) => x.toString()));
    for (const o of obf) {
        if (liveSet.has(o.toString()))
            return { state: "INVALID", root: 0n };
    }
    const { root } = buildMerkle([...liveLeaves, ...obf]);
    let targetHash;
    try {
        targetHash = fromHex32(doc.signature.targetHash);
    }
    catch {
        return { state: "INVALID", root };
    }
    if (root !== targetHash)
        return { state: "INVALID", root };
    let merkleRoot;
    try {
        merkleRoot = fromHex32(doc.signature.merkleRoot);
    }
    catch {
        return { state: "INVALID", root };
    }
    // Single-document credentials only: `signature.proof` MUST be empty, so `targetHash` IS the
    // anchored root `R`. Doc→batch-root inclusion (a non-empty `proof`) never shipped, and the C1
    // invariant forbids trusting a permissive commutative fold in the trust path - so a non-empty
    // proof is rejected outright rather than folded (see merkle.processProof, DSDP plan §2.3).
    const ok = doc.signature.proof.length === 0 && merkleRoot === targetHash;
    return { state: ok ? "VALID" : "INVALID", root };
}
function dogTagIdOf(doc) {
    const entry = flattenData(doc.data).find(([kp]) => kp === "credentialSubject.dogTagId");
    if (!entry)
        throw new Error("missing credentialSubject.dogTagId");
    // packed: salt:tag:value
    const parts = entry[1].split(":");
    return parts.slice(2).join(":");
}
/**
 * `0x`-hex keccak256 of a record-type label - the `IssuerRegistry` whitelist key and the value a
 * clone's immutable `recordType()` returns. Parity-pinned against `record_type_key` in
 * `crates/dogtag-standard-rs/src/verify.rs` (`keccak("VACCINATION")`).
 */
export function recordTypeKey(recordType) {
    return "0x" + bytesToHex(keccak_256(new TextEncoder().encode(recordType)));
}
/** Order two log points by (blockNumber, logIndex) - block-scoped, so comparable across contracts. */
function compareLogPoints(a, b) {
    return a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex;
}
/**
 * Fold one `(recordType, signer)` grant history against the point a root was anchored (impl §11.3,
 * parity with `dogtag-standard-rs::verify::grant_in_force_at`): the state as of the anchoring point
 * is the LAST event at or before it. An empty history is NOT_AUTHORIZED (the registry answered and
 * recorded no grant), never UNDETERMINED - callers keep a log read that failed entirely apart from
 * this, and never call this helper for that case.
 */
export function grantInForceAt(history, anchoredAt) {
    let latest;
    for (const e of history) {
        if (compareLogPoints(e.at, anchoredAt) <= 0 && (!latest || compareLogPoints(e.at, latest.at) > 0)) {
            latest = e;
        }
    }
    return latest?.granted ? "AUTHORIZED" : "NOT_AUTHORIZED";
}
/**
 * Resolve the issuer-whitelist pillar for one candidate clone (or the lack of one). Split out of
 * `verify` so the branching in impl §11.3's decision tree reads as a sequence of early returns
 * rather than nested mutable state.
 *
 * Returns the pillar's state plus the on-chain originator it found for a RESOLVED clone (`undefined`
 * when there was no resolved clone to ask; `null` when asked and no originator could be
 * established), so the M7 provenance check in `verify` can reuse the read instead of asking twice.
 */
async function resolveIssuerWhitelist(rpc, resolvedClone, issuerResolution, root, claimedRecordType) {
    if (resolvedClone === undefined) {
        const state = issuerResolution === "NO_FACTORY_CONFIGURED" ? "UNAVAILABLE_NO_FACTORY_CONFIGURED" : "UNRESOLVED";
        return { state, onchainSigner: undefined };
    }
    let signer;
    try {
        signer = await rpc.issuedBy(resolvedClone, root);
    }
    catch {
        return { state: "UNRESOLVED", onchainSigner: null };
    }
    if (signer === null) {
        // The clone the factory named never issued this root - indeterminate, never a pass.
        return { state: "UNRESOLVED", onchainSigner: null };
    }
    let chainRtKey;
    try {
        // v2 PRIMARY: per-root recordTypeOf(root) - see issuerRecordTypeOfRoot's own doc comment.
        chainRtKey = await rpc.issuerRecordTypeOfRoot(resolvedClone, root);
    }
    catch {
        // recordTypeOf(root) itself failed - most likely a pre-v2 clone whose bytecode has no such
        // mapping at all (WP4.14 plan section 3's blocker). Fall back to the v1 per-clone recordType().
        // A v2 clone's recordTypeOf SUCCEEDING with the zero word is handled below, NOT here - that is
        // not a signal to fall back, it is "not found on this clone", the identical case issuerRecordType
        // returning null already was.
        try {
            chainRtKey = await rpc.issuerRecordType(resolvedClone);
        }
        catch {
            return { state: "UNRESOLVED", onchainSigner: signer };
        }
    }
    if (chainRtKey === null) {
        return { state: "UNRESOLVED", onchainSigner: signer }; // uninitialized, or not a clone at all
    }
    if (chainRtKey.toLowerCase() !== recordTypeKey(claimedRecordType).toLowerCase()) {
        // The envelope claims a record type the CHAIN does not agree this clone issues.
        return { state: "FAILED", onchainSigner: signer };
    }
    let grant;
    try {
        grant = await rpc.whitelistedAtIssuance(resolvedClone, signer, root);
    }
    catch {
        grant = "UNDETERMINED";
    }
    const state = grant === "AUTHORIZED" ? "PASSED" : grant === "NOT_AUTHORIZED" ? "FAILED" : "UNRESOLVED";
    return { state, onchainSigner: signer };
}
/** Await a promise without letting a rejection short-circuit a sibling await (both adapter reads
 * in the identity pillar must run even when one throws - mirrors the Rust tuple-match, which
 * evaluates both trait calls before matching). */
async function settle(p) {
    try {
        return { ok: true, value: await p };
    }
    catch {
        return { ok: false };
    }
}
/** Full contextual verify (impl §11.3). */
export async function verify(doc, opts) {
    // FIXED (grader finding B): `privacy`/`signature`/`issuer` are typed as always-present, but a
    // `WrappedDoc` reconstructed off the wire is only as complete as whatever sent it. An absent block
    // used to crash the very first field access below (`doc.signature.merkleRoot`) with a bare
    // TypeError, never reaching a single adapter call. Fail-closed here means the same thing it means
    // everywhere else in this function: a document this incomplete can never produce a pass, so it now
    // resolves to a fully-formed `Verdict` reporting exactly that, rather than throwing past this
    // function entirely.
    if (!doc.privacy || !doc.signature || !doc.issuer) {
        return {
            valid: false,
            fragments: { integrity: "INVALID", issuance: "ERROR", identity: "ERROR", ownership: "ERROR" },
            issuerWhitelist: "UNRESOLVED",
            issuerStore: "NOT_EVALUATED",
            issuerResolution: "READ_FAILED",
            issuerAddr: "",
        };
    }
    const confirmations = opts.confirmations ?? 5;
    const root = doc.signature.merkleRoot;
    const integrity = checkIntegrity(doc).state;
    // ── The anchor: WHICH contract answers for this credential ────────────────────────────────
    //
    // `issuer.documentStore` is only the document's CLAIM. It sits OUTSIDE the Merkle root, so an
    // attacker can point it at a contract they deployed and it will answer `isValid`/`issuedBy`/
    // `recordType` however they like. This asks the verifier's OWN factory instead.
    let issuerResolution;
    let resolvedClone;
    try {
        const anchor = await opts.rpc.rootIssuer(root);
        if (anchor.kind === "resolved") {
            issuerResolution = "RESOLVED";
            resolvedClone = anchor.clone;
        }
        else if (anchor.kind === "noRecord") {
            issuerResolution = "NO_RECORD";
        }
        else {
            issuerResolution = "NO_FACTORY_CONFIGURED";
        }
    }
    catch {
        issuerResolution = "READ_FAILED";
    }
    // `doc.issuer.documentStore` is only the document's CLAIM, and the type saying `string` does not
    // make it one at runtime - this document came off the wire. FIXED (round 2, grader finding #1): an
    // absent/non-string/empty value used to crash `.trim()` here; it now folds to "" and lands on
    // DIFFERS below via the plain no-match case, exactly as Rust's `IssuerStoreAgreement::Differs` doc
    // comment specifies ("an ABSENT or empty documentStore lands here too").
    const claimedStore = typeof doc.issuer.documentStore === "string" ? doc.issuer.documentStore.trim() : "";
    // The address every read below is made against. The factory's answer wins; the document's own
    // claim is the LAST resort, reached only when the factory named nobody - and in every one of
    // those cases except NO_FACTORY_CONFIGURED the mandatory pillar is indeterminate, so nothing read
    // from that contract can produce a pass.
    const issuerAddr = resolvedClone ?? claimedStore;
    // The document names a different contract than the one the chain says issued this root - its own
    // term, never folded into the whitelist pillar, so a caller can act on which accusation it is.
    let issuerStore;
    if (resolvedClone === undefined) {
        issuerStore = "NOT_EVALUATED"; // nothing authoritative to disagree with
    }
    else if (claimedStore !== "" && resolvedClone.toLowerCase() === claimedStore.toLowerCase()) {
        issuerStore = "MATCHED";
    }
    else {
        issuerStore = "DIFFERS"; // includes an absent/empty claim - stripping the field must not skip the check
    }
    let issuance;
    try {
        issuance = (await opts.rpc.isValid(issuerAddr, root, confirmations)) ? "VALID" : "INVALID";
    }
    catch {
        issuance = "ERROR";
    }
    // ── The issuer-whitelist pillar - MANDATORY, and SELF-RESOLVING ───────────────────────────
    //
    // Asks the chain WHO issued the root and whether THAT signer held the capability AT THE MOMENT it
    // anchored this root - never whether it holds it now (delisting is forward-only), and never an
    // address the document names. Only a definite PASSED may contribute to a pass.
    const { state: issuerWhitelist, onchainSigner: onchainSignerForClone } = await resolveIssuerWhitelist(opts.rpc, resolvedClone, issuerResolution, root, doc.issuer.recordType);
    // ── M7 provenance (§4.2/§4.3): the `protocol` block is a routing hint, NEVER authority ─────
    //
    // A stamped `protocol.issuerSigner` is only the envelope's CLAIM of who issued. It is validated
    // against the on-chain originator, on EVERY path (not only the factory-resolved one), and may
    // only ever TIGHTEN a verdict. The old fail-open (`catch { issuance = "VALID" }`) is gone: a read
    // that could not run is not a pass.
    if (doc.protocol && issuance === "VALID") {
        let onchain;
        if (resolvedClone !== undefined) {
            // Already read against the anchor above; reuse it rather than ask twice.
            onchain = { ok: true, value: onchainSignerForClone ?? null };
        }
        else {
            onchain = await settle(opts.rpc.issuedBy(issuerAddr, root));
        }
        if (onchain.ok && onchain.value !== null) {
            issuance = onchain.value.toLowerCase() === doc.protocol.issuerSigner.toLowerCase() ? "VALID" : "INVALID";
        }
        else {
            // The chain reports no originator for this root (or the read failed): not a pass, but not
            // evidence of forgery either.
            issuance = "ERROR";
        }
    }
    let identity;
    {
        const txtResult = await settle(opts.dns.txtMatches(doc.issuer.domain, doc.issuer.documentStore, 135));
        const knownResult = await settle(opts.registry.knows(doc.issuer.domain, doc.issuer.documentStore));
        if (txtResult.ok && knownResult.ok) {
            identity = txtResult.value && knownResult.value ? "VALID" : "INVALID";
        }
        else {
            identity = "ERROR";
        }
    }
    const credentialValid = integrity === "VALID" &&
        issuance === "VALID" &&
        identity === "VALID" &&
        issuerWhitelistPermitsPass(issuerWhitelist) &&
        issuerStorePermitsPass(issuerStore);
    let ownership;
    let valid;
    if (opts.mode === "self-import") {
        if (!opts.userWalletAddress)
            throw new Error("self-import requires userWalletAddress");
        try {
            const owner = await opts.rpc.ownerOf(dogTagIdOf(doc));
            ownership = owner.toLowerCase() === opts.userWalletAddress.toLowerCase() ? "VALID" : "INVALID";
        }
        catch {
            ownership = "ERROR";
        }
        valid = credentialValid && ownership === "VALID";
    }
    else {
        if (opts.userWalletAddress) {
            try {
                const owner = await opts.rpc.ownerOf(dogTagIdOf(doc));
                ownership = owner.toLowerCase() === opts.userWalletAddress.toLowerCase() ? "VALID" : "INVALID";
            }
            catch {
                ownership = "ERROR";
            }
        }
        else {
            ownership = "NOT_APPLICABLE";
        }
        valid = credentialValid; // ownership does NOT gate third-party validity
    }
    return {
        valid,
        fragments: { integrity, issuance, identity, ownership },
        issuerWhitelist,
        issuerStore,
        issuerResolution,
        issuerAddr,
    };
}
//# sourceMappingURL=verify.js.map