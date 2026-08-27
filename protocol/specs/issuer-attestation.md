# Issuer attestation (C3)

This document specifies the EIP-712 envelope attestation every issued credential document (`WrappedDoc`) carries, why it exists, and exactly how a verifier checks it.
It implements dossier finding M-3: v1 shipped an `issuer` and `protocol` block on every credential envelope with no signature binding either to the actual on-chain anchoring event, so both were trivially forgeable off-chain claims.
v2 makes the anchoring signer's identity offline-authenticatable by having them sign over the fields that matter, at the moment they anchor the root.

## The domain

```json
{
  "name": "DogTagIssuerAttestation",
  "version": "1",
  "chainId": 135,
  "verifyingContract": "<issuer clone address>"
}
```

- `name` and `version` are fixed constants; they never change without a new attestation version.
- `chainId` is always `135` (ROAX testnet) for the current round; the identity protocol lives only there.
- `verifyingContract` is the specific `VetIssuer` clone (ERC1967 proxy) that anchored this root, not the factory and not the default implementation.
  Binding the domain to the clone means a signature produced for one clone's attestation can never be replayed as if it came from a different clone, even if the same operator wallet is whitelisted on both.

## The message

```json
{
  "merkleRoot": "bytes32",
  "recordType": "bytes32",
  "issuerContract": "address",
  "issuerName": "string",
  "issuerDomain": "string"
}
```

- `merkleRoot` is the anchored root `R`, exactly as sealed on chain (`profileRoot(dogTagId)` for a profile tree, or the record root for a non-profile credential).
- `recordType` is the keccak256-derived constant for this credential's record type (`DOG_PROFILE`, `VACCINATION`, `TRAVEL_CLEARANCE`, `EU_HEALTH_CERT`, and so on), never a free string, matching every other on-chain record-type reference in the protocol.
- `issuerContract` is the same clone address as `verifyingContract` in the domain, restated inside the message so a verifier that only logs the message body (rather than the full typed-data domain) still has it.
- `issuerName` and `issuerDomain` are the human-facing issuer identity fields also carried in the envelope's `issuer` block (`packages/dogtag-standard-ts/src/types.ts`'s `IssuerMeta`); signing them binds the previously unprotected display fields to the same signature that binds the cryptographic ones.

## The signer

The signer MUST be the operator wallet that actually anchored `merkleRoot` on `issuerContract` at issuance: the address `VetIssuer.issuedBy(root)` reports for this root, which is set to `msg.sender` inside `issueTag`/`issueRecord`, both restricted to `onlyOperator`.
The attestation is produced at the moment of anchoring, by the same wallet, over the same transaction's inputs; it is not a separate identity document issued at some later time by whichever wallet happens to be signing that day.

## Where it rides

The signature travels inside `WrappedDoc.protocol` (`packages/dogtag-standard-ts/src/types.ts`'s `ProtocolMeta`), alongside `issuerSigner`, `issuerClone`, `chainId`, and `verificationRegistry`.
The `protocol` block sits outside the Merkle root `R`, exactly like the `issuer` block: neither is a leaf, so stamping or restamping either after issuance never disturbs the anchored root (`stamping_a_status_base_url_does_not_move_the_merkle_root` in `crates/dogtag-standard-rs/src/verify.rs` pins the same invariant for the sibling `statusBaseUrl` field).
This is a deliberate design property, not an oversight: it is what lets the issuing stack attach a signature and other provenance metadata after the fact, or amend non-cryptographic fields such as a receipt status URL, without invalidating a single credential already in the wild.

Because the `protocol` block sits outside `R`, the attestation signature is never an input to consent-circuit soundness and never a substitute for the credential's own integrity check (`checkIntegrity` / `check_integrity`).
It is a second, independent authenticity layer: integrity proves the document's fields fold to the claimed root, and the attestation proves a specific, identifiable signer chose to anchor that root under that record type.

## How verifiers check it

Both the mandatory issuer-whitelist pillar (`crates/dogtag-standard-rs/src/verify.rs`, `IssuerWhitelistState`) and this document describe the same underlying question from two angles: was the entity that produced this credential actually authorized to?
The whitelist pillar answers that question entirely from on-chain reads (`rootIssuer`, `issuedBy`, `issuerRecordType`, `whitelistedAtIssuance`) and needs no signature at all, because every on-chain read is already unforgeable by construction.
The attestation exists for the case an on-chain read is not available at verification time: an air-gapped verifier, a cached credential shown offline, or a first pass before a network round trip.
Such a verifier checks, in order:

1. **Signature validity.** Recover the signer from the EIP-712 domain and message above; a malformed or non-recovering signature is a hard reject.
2. **Whitelisted at anchor time.** The recovered signer was a whitelisted operator of `issuerContract` at the moment `merkleRoot` was anchored, not merely at verification time; delisting is forward-only (`VetIssuer.sol`'s `removeOperator` only flips the whitelist mapping going forward and never rewrites which past roots a since-removed operator anchored), so a current-state check would wrongly refuse a genuine credential from an operator who has since rotated out.
   An online verifier reconstructs this from the governing registry's grant-history log, exactly as `crates/dogtag-standard-rs/src/verify.rs`'s `GrantAtIssuance` / `grant_in_force_at` do; an offline verifier that cannot reach the chain treats this step as indeterminate, never as a pass, and surfaces that distinctly from a definite failure.
3. **Clone matches `rootIssuer[R]`.** `issuerContract` (and hence `verifyingContract`) must equal the address the verifier's own `VetIssuerFactory.rootIssuer(merkleRoot)` names for this root, once that read is available.
   This is the same anchor substitution defense the whitelist pillar enforces: `issuer.documentStore` and now `protocol.issuerSigner`/`issuerContract` are the document's own claims, and only the verifier's own factory read is authoritative about which contract actually issued a given root.
   A signature that is otherwise perfectly valid but names a clone the factory did not index for this root is a forged-issuer attempt, not a genuine credential with a clerical mismatch, and MUST be rejected.

A verifier that can reach the chain always prefers the on-chain reads (steps 2 and 3 restated as live queries) over the offline attestation once both are available; the attestation upgrades a "we could not check" into a checkable claim for the offline case, but it never outranks a live on-chain read that disagrees with it.
