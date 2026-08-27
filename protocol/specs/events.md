# DogTag v2 contract events

This document explains the semantics of every v2 contract event, and is a complete, field-by-field companion to the generated machine manifest at `contracts/exports/events.json` (contract, event name, full signature, topic0 for every event in the v2 set).
Every event `events.json` lists appears below with a matching signature, and nothing below is absent from, or extra to, that manifest.
The admin indexer is the primary consumer of most of these events; this document also covers the standard OpenZeppelin administrative events every contract inherits and the `ProtocolRegistry` discovery/governance events, both of which sit outside the indexer's own tag-lifecycle stream described next.

## Why the indexer treats these as one stream

The admin indexer follows `EntityRegistry`, `VetIssuerFactory`, every `VetIssuer` clone (discovered via `VetDeployed`), `DogTagSBTConsent`, and `VerificationRegistryConsent` from their deployment blocks.
It persists every event, tag lifecycle, per-clone gas balances and refund spend, and powers the admin dashboards and the global activity timeline.
A clone is not known ahead of time, so the indexer subscribes to new clones as `VetDeployed` names them, then follows each clone's own log from its deployment block forward.

## EntityRegistry

The single on-chain register of approved business entities.

- `EntityAdded(address indexed account, EntityRegistry.EntityKind kind, string name, string registrationId, bytes32 docsHash)`.
  Fired by `addEntity`.
  Marks the moment an applicant becomes a known entity; the indexer creates its directory row here.
- `EntityUpdated(address indexed account, string name, string registrationId, bytes32 oldDocsHash, bytes32 newDocsHash)`.
  Fired by `updateEntity`.
  Carries the full new `name` and `registrationId` alongside both the old and new `docsHash`, so a profile edit and a re-hash are both visible without a second read.
  The indexer keeps every historical `docsHash` for audit history, never only the latest.
- `EntityAccountUpdated(address indexed oldAccount, address indexed newAccount)`.
  Fired by `updateEntityAccount`.
  The entity's on-chain wallet changed; the indexer must re-key the entity row and the corresponding `VetIssuerFactory.cloneOf` lookup together, or the two stores disagree about which clone belongs to this entity.
- `EntityRevoked(address indexed account, bytes32 reasonCode)`.
  Fired by `revokeEntity`.
  The entity loses `isActive`; the indexer marks it revoked everywhere it appears (directory, vet platform banner, cross-vet index) per the "entity revoked" acceptance anchor.
  Revocation freezes new tag issuance on the entity's clone but does not invalidate tags already issued.
- `EntityReinstated(address indexed account, bytes32 reasonCode)`.
  Fired by `reinstateEntity`.
  Reverses a revocation; the indexer clears the revoked banner everywhere it was shown.
- `AdminApiUrlSet(string url)`.
  Fired by `setAdminApiUrl`.
  Changes the single discovery URL every mobile app resolves from chain; the indexer does not act on this itself, but logs it since a wrong value here breaks discovery ecosystem-wide.
- `VerifierCapabilitySet(bytes32 indexed purpose, address indexed relayer, bool allowed)`.
  Fired by `setVerifierCapability`.
  Grants or revokes a relayer's standing to request consent proofs for one purpose; the indexer surfaces this on the relayer's admin page.
- `Initialized(uint64 version)`, `Upgraded(address indexed implementation)`, `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)`, `OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)`.
  The standard `Initializable` / `UUPSUpgradeable` / `Ownable2StepUpgradeable` lifecycle events every upgradeable, owner-controlled v2 contract emits.
  See *Inherited administrative events* below for what each one means.

## VetIssuerFactory

Admin-driven deployment and per-clone bookkeeping for `VetIssuer`.

- `VetDeployed(address indexed entityAccount, address indexed clone, address implementation)`.
  Fired by `deployVet`.
  The event that makes a new clone visible to every other consumer of this stream: the indexer starts following the named clone's own log from this event's block forward, and the entity's directory row gains its `platformBaseUrl` wiring.
- `DefaultImplementationSet(address indexed implementation)`.
  Fired by `setDefaultImplementation`.
  Changes what future `deployVet` calls deploy; does not affect already-deployed clones.
- `CloneOwnerSynced(address indexed oldAccount, address indexed newAccount, address indexed clone)`.
  Fired by `syncCloneOwner`.
  The second half of an `EntityAccountUpdated` repoint; the indexer uses this to confirm the factory and registry agree about which account a clone belongs to.
- `CloneUpgraded(address indexed clone, address indexed newImplementation)`.
  Fired by `upgradeClone` (and once per clone in a batch `upgradeClones` call).
  The indexer records this in the same versioned-artifact history the admin editor keeps for every deployable, so an old implementation is never forgotten even after the clone moves off it.
- `RootIndexed(bytes32 indexed root, address indexed clone)`.
  Fired by `indexRoot`, called internally from a clone's `issueTag`/`issueRecord`.
  This is the write-once anchor a verifier's own factory read (`rootIssuer(R)`) resolves against; see `specs/issuer-attestation.md` and `crates/dogtag-standard-rs/src/verify.rs` for why every verdict-deciding read is made against the clone THIS event names, never a clone the credential document merely claims.
- `Initialized(uint64 version)`, `Upgraded(address indexed implementation)`, `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)`, `OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)`.
  The same standard upgradeable/ownership lifecycle events as `EntityRegistry`.
  See *Inherited administrative events* below.

## VetIssuer (per clone, same ABI on every deployed instance)

- `VetIssuerInitialized(address indexed vetOwner, address indexed factory)`.
  Fired once by `initialize`, at clone deployment.
  Names the entity account this clone issues for and the factory that deployed it; the indexer uses this to confirm a newly-discovered clone (via `VetDeployed`) actually initialized against the entity account the factory named for it.
- `OperatorSet(address indexed operator, bool allowed)`.
  Fired by `addOperator` / `removeOperator`, both `onlyFactoryAdmin`.
  Load-bearing for whitelist reconstruction: this clone exposes no enumerable operator list, so knowing who was whitelisted at any past moment - not only who is whitelisted now - means replaying every `OperatorSet` from this clone's deployment block forward.
  Both the indexer and an offline verifier reconstructing whether a signer was whitelisted at issuance time (`specs/issuer-attestation.md`, "Whitelisted at anchor time") depend on this event for exactly that reason.
- `VetOwnerSet(address indexed oldOwner, address indexed newOwner)`.
  Fired by `setVetOwner`, called directly by `VetIssuerFactory.syncCloneOwner` (or by the factory admin) as part of the same account-rotation flow `CloneOwnerSynced` completes.
  The indexer uses this to confirm the clone's own record of who it issues for agrees with the factory's `cloneOf` and the registry's account key, after a rotation.
- `MaxRefundSet(uint256 amount)`.
  Fired by `setMaxRefund`.
  Changes the per-call gas-refund ceiling `refundsGas` pays out going forward; does not affect a call already in flight.
- `TagIssued(uint256 indexed dogTagIdField, bytes32 indexed root, address operator)`.
  Fired by `issueTag`.
  The atomic mint moment: this clone's root is anchored and the custodial SBT is minted in the same transaction (v2 removes the v1 two-transaction issue-then-mint ordering hazard).
  The indexer's tag lifecycle timeline starts here.
- `TagRevoked(uint256 indexed dogTagIdField, bytes32 root, bytes32 reasonCode, address by)`.
  Fired by `revokeTag`.
  Stops the tag from passing `isValid`, which is what makes `VerificationRegistryConsent` reject it with `cred !valid`; the indexer shows this on the tag's timeline with its reason code.
  This is a clone-local root flag only, never a call into `DogTagSBTConsent.setStatus`: the SBT's own `Deceased`/`Revoked` statuses are permanent, so routing through them would make `reactivateTag` permanently unreachable after a single revoke.
- `TagReactivated(uint256 indexed dogTagIdField, bytes32 root, bytes32 reasonCode, address by)`.
  Fired by `reactivateTag`.
  Reverses a revocation; `isValid` answers true again and verification resumes.
  A replace flow (mint a new tag, then revoke the old one) shows as a `TagIssued` on the new id followed by a `TagRevoked` on the old one, both attributable to the same operator and close in time; the indexer's timeline renders both together.
- `RecordIssued(bytes32 indexed recordType, bytes32 indexed root, address operator)`.
  Fired by `issueRecord`.
  Non-profile credential documents (vaccination, travel) issued by this clone; `recordType` is one of the keccak256-derived constants, never a free string.
- `RecordRevoked(bytes32 indexed root, bytes32 reasonCode, address by)` / `RecordReactivated(bytes32 indexed root, bytes32 reasonCode, address by)`.
  Fired by `revokeRecord` / `reactivateRecord`.
  Same lifecycle shape as tag revoke/reactivate, scoped to a non-profile record root.
- `RefundSkipped(address indexed operator, uint256 wanted)`.
  Fired inside the `refundsGas` modifier when the clone's native balance cannot cover the operator's gas refund.
  The underlying action (issue, revoke, reactivate) still succeeds; the indexer uses this to flag a clone that needs a top-up before its operators start eating their own gas.
- `FundsReceived(address indexed from, uint256 amount)`.
  Fired by the clone's `receive()`.
  A top-up to the clone's gas-refund balance; the indexer's per-clone balance dashboard sums these against refund spend.
- `Withdrawn(address indexed to, uint256 amount)`.
  Fired by `withdraw`, `onlyFactoryAdmin`.
  Removes native balance from the clone's gas-refund pool; the indexer's per-clone balance dashboard nets this against `FundsReceived` and refund spend.
- `Initialized(uint64 version)`, `Upgraded(address indexed implementation)`.
  The standard `Initializable`/`UUPSUpgradeable` lifecycle events; see *Inherited administrative events* below.
  This clone has no `Ownable`-style events of its own: `factoryAdmin()` authenticates every admin call live against the factory's current owner rather than against any state of this clone's own, so `VetIssuerInitialized`/`OperatorSet`/`VetOwnerSet`/`MaxRefundSet` above are this clone's only admin-facing events.

## DogTagSBTConsent

- `Issued(uint256 indexed dogTagId, address indexed issuer)`.
  Fired by `mintCustodial`, in the same transaction as `Locked` below.
  `issuer` is the calling `VetIssuer` clone's own contract address - the entity granted `ISSUER_ROLE` on this shared SBT contract - never a human operator wallet and never the pet owner.
  This is the SBT-side half of the atomic issuance moment `VetIssuer`'s `TagIssued` marks on the issuer-clone side; both fire in the same `issueTag` transaction.
- `Locked(uint256 tokenId)` / `Unlocked(uint256 tokenId)`.
  Declared by the ERC-5192 soulbound interface this contract implements.
  `Locked` fires once, alongside `Issued`, at every mint.
  `Unlocked` is never actually emitted: `locked()` always answers `true` and this contract has no unlock path, so `Unlocked` exists in the ABI only because the interface declares it, not because any call here fires it.
- `StatusChanged(uint256 indexed dogTagId, uint8 from, uint8 to, address by, bytes32 reasonCode)`.
  Fired by `setStatus`.
  The v2 replacement for v1's unused `string reason` parameter (C6, no free text on chain).
  The indexer treats this as the authoritative status timeline for a tag; `VerificationRegistryConsent`'s M-1 gate reads the current status live, but the indexer's history view is built entirely from this event stream.
- `Burned(uint256 indexed dogTagId)`.
  Fired by `burn`, `DEFAULT_ADMIN_ROLE`-only.
  The GDPR-erasure path: `profileRoot[id]` deliberately survives the burn so the existence gate (`ownerOf` reverting on a burned token) stays load-bearing, but the id itself is retired permanently and can never be re-minted.
- `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)`.
  Fired by the inherited ERC721 `_update` on every mint and burn.
  `mintCustodial` is the only mint path (`from == address(0)`, `to == custodian`) and `burn` is the only burn path (`to == address(0)`); a holder-to-holder transfer is structurally impossible, since `_update` reverts `Soulbound` whenever both `from` and `to` are non-zero.
- `Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)` / `ApprovalForAll(address indexed owner, address indexed operator, bool approved)`.
  Inherited ERC721 events for the `approve`/`setApprovalForAll` calls this contract does not override or disable.
  Neither has any practical effect here: the soulbound check in `_update` rejects every holder-to-holder transfer regardless of approval, so an emitted `Approval`/`ApprovalForAll` never enables an actual transfer.
- `RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)`, `RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)`, `RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)`, `DefaultAdminTransferScheduled(address indexed newAdmin, uint48 acceptSchedule)`, `DefaultAdminTransferCanceled()`, `DefaultAdminDelayChangeScheduled(uint48 newDelay, uint48 effectSchedule)`, `DefaultAdminDelayChangeCanceled()`.
  Standard `AccessControl`/`AccessControlDefaultAdminRules` events, gating `ISSUER_ROLE`, `AUTHORITY_ROLE`, and the two-step `DEFAULT_ADMIN_ROLE` handover.
  See *Inherited administrative events* below for what each one means.

## VerificationRegistryConsent

- `Verified(uint256 indexed dogTagId, address indexed relayer, bytes32 purpose, bytes32 nullifier, uint256 deadline, uint256 ts)`.
  Fired by `recordVerificationZK` when a consent proof passes every one of the 13 gates, including the M-1 status gate (tag `status` must be neither `Deceased` nor `Revoked`; `Active`, `Lost`, and `TransferPending` all pass).
  Owner-blind by construction: there is no `subject`/owner field anywhere in this signature, so its topic0 itself commits to the owner-hidden event shape rather than merely the values carried inside it.
  `deadline` restates the proof's own expiry from the public signal, and `ts` is `block.timestamp` at the moment the verification landed on chain.
  The indexer's cross-vet activity timeline and the relayer's own verification history are both built from this event; `nullifier` is what a client checks to confirm a specific proof was actually consumed rather than merely accepted off-chain.
- `ZkVerifierProposed(address indexed verifier, uint256 eta)`.
  Fired by `proposeZkVerifier`, `DEFAULT_ADMIN_ROLE`-only.
  Stages a Groth16 verifier swap; `eta` is the earliest timestamp `executeZkVerifier` may act on it, a real timelock on the circuit-verifier identity (§11.10(g)).
- `ZkVerifierUpdated(address indexed verifier)`.
  Fired by `executeZkVerifier` once `eta` has passed.
  Names the new `zkVerifier` every subsequent `recordVerificationZK` call proves against.
- `RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)`, `RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)`, `RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)`, `DefaultAdminTransferScheduled(address indexed newAdmin, uint48 acceptSchedule)`, `DefaultAdminTransferCanceled()`, `DefaultAdminDelayChangeScheduled(uint48 newDelay, uint48 effectSchedule)`, `DefaultAdminDelayChangeCanceled()`.
  Standard `AccessControl`/`AccessControlDefaultAdminRules` events, gating the two-step `DEFAULT_ADMIN_ROLE` handover (this registry defines no role beyond `DEFAULT_ADMIN_ROLE` itself).
  See *Inherited administrative events* below for what each one means.

## ProtocolRegistry

The discovery trust anchor: two independently-rotatable axes - which deployed contracts belong together, and which off-chain proving artifacts an app must fetch - joined by one governance-controlled binding.
Every write that could steer a client follows `propose` then a timelock (`PUBLISH_TIMELOCK`) then `execute`; `deprecate` is the sole immediate, un-timelocked lever, and it cancels any in-flight proposal for the id it targets rather than merely racing it.
This registry sits outside the admin indexer's tag-lifecycle stream described above: it is what a mobile app itself reads, directly, to decide which contracts and which proving artifacts to trust for a given protocol version.

- `DiscoverySetProposed(bytes32 indexed discoverySetId, uint256 eta)`.
  Fired by `proposeDiscoverySet`, `PUBLISHER_ROLE`-only.
  Stages the on-chain half of a protocol version - the `factory`/`verificationRegistry`/`sbt`/`verifier`/`entityRegistry` addresses and a `circuitId`; `eta` is the earliest `executeDiscoverySet` may act on it.
- `DiscoverySetPublished(bytes32 indexed discoverySetId, bool isNew)`.
  Fired by `executeDiscoverySet` once `eta` has passed.
  `isNew` distinguishes a set's first publication from a swap-republish of an id that was already live; only a first publication appends to the enumerable `discoverySetList`.
- `DiscoverySetDeprecated(bytes32 indexed discoverySetId)`.
  Fired by `deprecateDiscoverySet`.
  Immediate, not timelocked: flips the set's `active` flag false and cancels any pending proposal for the same id, without deleting the published record itself.
- `ArtifactSetProposed(bytes32 indexed artifactSetId, uint256 eta)`.
  Fired by `proposeArtifactSet`, `PUBLISHER_ROLE`-only.
  Stages the off-chain half: the proving-artifact fetch pins (`zkeySha256` and its siblings), `artifactBaseUrl`, and the `minAppVersion` floor.
- `ArtifactSetPublished(bytes32 indexed artifactSetId, bool isNew)`.
  Fired by `executeArtifactSet` once `eta` has passed.
  Same first-publication-versus-republish distinction as `DiscoverySetPublished`.
- `ArtifactSetDeprecated(bytes32 indexed artifactSetId)`.
  Fired by `deprecateArtifactSet`.
  Immediate; also cancels any in-flight proposal, which matters more on this axis since a stale `activeArtifactSetOf` binding would otherwise keep resolving to the now-deprecated set.
- `ArtifactBindingProposed(bytes32 indexed discoverySetId, bytes32 indexed artifactSetId, uint256 eta)`.
  Fired by `proposeArtifactBinding`, `PUBLISHER_ROLE`-only.
  Stages "resolve `discoverySetId` to `artifactSetId`" - the single link between the two axes.
- `ArtifactBindingSet(bytes32 indexed discoverySetId, bytes32 indexed artifactSetId)`.
  Fired by `executeArtifactBinding` once `eta` has passed and both sides are confirmed published and active.
  The write that actually makes an artifact rotation visible to a resolving app; it touches no `DiscoverySet` field.
- `RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)`, `RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)`, `RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)`, `DefaultAdminTransferScheduled(address indexed newAdmin, uint48 acceptSchedule)`, `DefaultAdminTransferCanceled()`, `DefaultAdminDelayChangeScheduled(uint48 newDelay, uint48 effectSchedule)`, `DefaultAdminDelayChangeCanceled()`.
  Standard `AccessControl`/`AccessControlDefaultAdminRules` events, gating `PUBLISHER_ROLE` and the two-step `DEFAULT_ADMIN_ROLE` handover.
  See *Inherited administrative events* below for what each one means.

## Inherited administrative events

Every event in this section comes from an OpenZeppelin base contract, unmodified.
Each is listed once here, with a pointer from every contract section above that emits it, rather than repeated per contract.

### Upgradeable lifecycle (`EntityRegistry`, `VetIssuer`, `VetIssuerFactory`)

- `Initialized(uint64 version)`.
  Fired once, inside `initialize`, by OpenZeppelin's `Initializable`.
  Confirms the proxy's storage was set up exactly once; a second `initialize` call reverts rather than emitting a second copy.
- `Upgraded(address indexed implementation)`.
  Fired by `UUPSUpgradeable` whenever `upgradeToAndCall` swaps the proxy's implementation.
  The indexer's versioned-artifact history keys off this event on every proxy, not only on `VetIssuerFactory`'s own `CloneUpgraded`, since `EntityRegistry` and `VetIssuerFactory` are themselves upgradeable proxies with no wrapping factory event of their own.

### Two-step ownership (`EntityRegistry`, `VetIssuerFactory`)

- `OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)`.
  Fired by `transferOwnership`, from OpenZeppelin's `Ownable2StepUpgradeable`.
  Ownership has not moved yet; `newOwner` must still call `acceptOwnership`.
- `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)`.
  Fired once `acceptOwnership` completes the handover (or once at initialization, naming the zero address as `previousOwner`).
  The indexer treats this, not `OwnershipTransferStarted`, as the moment admin authority actually moves.

### Role-based access control (`DogTagSBTConsent`, `VerificationRegistryConsent`, `ProtocolRegistry`)

- `RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)` / `RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)`.
  Fired by OpenZeppelin `AccessControl` whenever a role is granted or revoked, including at construction.
  `sender` is whoever called `grantRole`/`revokeRole`, not necessarily the role's own admin at some later time.
- `RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)`.
  Fired whenever a role's admin role is repointed.
  In practice these contracts never repoint a role's admin themselves, so this stays theoretical on all three: `DogTagSBTConsent` overrides `_setRoleAdmin` only for multi-inheritance plumbing (routing the call through both `AccessControlEnumerable` and `AccessControlDefaultAdminRules`), never to invoke it.
- `DefaultAdminTransferScheduled(address indexed newAdmin, uint48 acceptSchedule)` / `DefaultAdminTransferCanceled()`.
  Fired by `AccessControlDefaultAdminRules.beginDefaultAdminTransfer` / `cancelDefaultAdminTransfer`.
  The two-step, timelocked handover of `DEFAULT_ADMIN_ROLE` itself; `acceptSchedule` is when `newAdmin` may call `acceptDefaultAdminTransfer`.
- `DefaultAdminDelayChangeScheduled(uint48 newDelay, uint48 effectSchedule)` / `DefaultAdminDelayChangeCanceled()`.
  Fired by `AccessControlDefaultAdminRules.changeDefaultAdminDelay` / `rollbackDefaultAdminDelay`.
  Governs how long a future admin transfer must wait, not the one currently in flight.

## Event fields that are deliberately absent

No event in this list carries the owner's wallet address, as `to`, as `msg.sender`, or in any other field.
The owner-unlinkability model is identity-level, not event-level: the tag's verification history is intentionally public, and the issuing vet holds the id-to-owner mapping off chain.
Product copy and any UI built from this event stream must say so honestly (C8) rather than imply the verification history itself is private.
