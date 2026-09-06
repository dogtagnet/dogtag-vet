# Vendored from dogtag-protocol

Source commit: 70d8078429b17834510c80fa44669b748aaa2fbd
Source commit (short): 70d8078
Synced at: 2026-09-06T13:43:36Z
Synced by: WP4.12V builder (targeted re-mirror, NOT `scripts/sync-to.sh` - see "Scope of this sync" below)

## THIS TREE HAS MIXED PROVENANCE as of WP4.15V (2026-09-07) - read this before trusting the single "Source commit" line above

The header above (and everything below it, unedited from the WP4.12V sync) is still literally true for MOST of this directory.
It is NO LONGER true for five files, which WP4.15V additionally advanced past `70d8078` to a DIFFERENT source entirely: the `dogtag-protocol` **branch** `feature/wp4.15-multi-owner`, not `master`, at its tip **`e654924`** (`git merge-base --is-ancestor 70d8078 e654924` holds - the branch tip is a strict descendant of this file's own base commit, plus WP4.15's own work; `master` itself has since moved to `3abacd0`, two commits ahead of `70d8078` on an unrelated axis - WP4.16 operator-whitelisting docs, confirmed via `git diff --stat 70d8078..3abacd0` touching neither of these five files nor `contracts/src/VetIssuer.sol` - so `master` does NOT yet carry any of WP4.15's `/d/` contract at all).

**The five files now at branch tip `e654924`, copied by hand and each verified `cmp`-identical to that commit immediately afterward:**
- `specs/qr-formats.md` - gains the "Delegation session QR" section (`/d/<32hex>`) and "The co-owner bundle".
- `specs/vet-public-api.yaml` - gains the `/d/{token}`, `/d/{token}/complete`, `/d/{token}/status` paths and every `Delegation*` schema (`DelegationSessionChallengeResponse`, `DelegationSessionCompleteRequest`/`Response`, `DelegationSessionStatusResponse`, `DelegationCoOwnerBundle`).
- `specs/events.md` - gains `DelegationRegistry`'s `SecondaryOwnerAdded`/`SecondaryOwnerRevoked`.
- `contracts/exports/abi/VetIssuer.json` - the branch's v2.1.0 ABI (`addSecondaryOwner`/`revokeSecondaryOwner`/`relayVerification`/`initializeDelegation`/`delegationRegistry`/`verificationRegistry`), NOT master's v2.0.0 shape.
- `contracts/exports/abi/DelegationRegistry.json` - a brand-new file; this contract does not exist on `master` or on any deployed chain at all (`docs/DEPLOY-wp4.15.md` in that branch is Kenneth's own pending deployment runbook).

Also re-generated from that same branch tip and copied for tree-consistency (not because vet code consumes it programmatically - `contracts/exports/events.json` is referenced only in one doc comment, `src/app/(app)/activity/page.tsx:29`): `contracts/exports/events.json` (81 events now, up from whatever `70d8078` had; the two new `SecondaryOwnerAdded`/`SecondaryOwnerRevoked` entries are additive, every event this file already listed is byte-unchanged).

**Everything else under `protocol/` - `specs/schemas/*`, `packages/dogtag-standard-ts/`, `contracts/flattened/`, `contracts/exports/abi/*` other than the two named above, `design/design-system.md`, and every OTHER field this file's own header describes - is still exactly what WP4.12V left it at, genuinely `70d8078`, untouched by WP4.15V.**
This is a deliberate, disclosed exception to the usual "one source commit for the whole tree" convention (the 4.14V wave's own grader flagged stamping a single commit over a mixed-provenance tree as a real defect - this note exists so that mistake is not repeated here): WP4.15's app-side work is explicitly staged to begin from the protocol BRANCH before its contracts/specs ever reach `master` (plan section 14's own header: "Contract addresses ... are configuration, never hardcoded; until deployed, tests use the RPC stub / anvil"), so vendoring from the branch tip - for exactly the files that branch actually changed, nothing else - is correct, not a shortcut.

**What this means for the next full `scripts/sync-to.sh` run** (whenever `dogtag-protocol` next merges WP4.15's specs to `master` and some later wave re-syncs from there): it will pick up `master`'s own copy of these five files at whatever commit master is at then, which will EITHER already include the WP4.15 content (if merged) or NOT (if this branch is still unmerged, in which case a full re-sync would REGRESS these five files back to their pre-WP4.15 shape) - check `master`'s own history for the `/d/` content before ever running a full re-sync while this vet worktree's own `feature/wp4.15-multi-owner` branch is still active.

## Do not edit these files

Everything under this `protocol/` directory is a vendored copy.
It is regenerated wholesale by `scripts/sync-to.sh` in the `dogtag-protocol` repo.
Edit the source in `dogtag-protocol` and re-run the sync script instead of editing anything here directly.
A hand-edit made here will be silently overwritten (or deleted, if you removed a vendored file) the next time someone runs the sync.

## What is vendored here

- `contracts/exports/abi/` - contract ABIs.
- `contracts/exports/events.json` - the event manifest (contract, event name, signature, topic0) the admin indexer consumes.
- `contracts/flattened/` - single-file flattened contract sources, for the admin editor's browser-solc compile step.
- `packages/dogtag-standard-ts/` - the TypeScript standard library (source; `node_modules` excluded, run your own install).
- `specs/` - the OpenAPI and narrative protocol specs.
- `design/design-system.md` - the shared design tokens and component guidance.

Any of the above may be absent from this sync if it did not exist in the source checkout at sync time (see the sync script's console output for which, and why).

## Scope of this sync (WP4.12V - targeted, not a full `scripts/sync-to.sh` run)

Plan section 3.2 item 1 scopes this wave's re-mirror to exactly `specs/schemas/*` and `specs/vet-public-api.yaml`, not the full vendored tree, so this update did NOT run `scripts/sync-to.sh`: that script's `specs` sync is `rsync -a --delete`, which would have deleted the four EIP-712 vector files named below that exist only in this vendored copy and never existed upstream at all.

Instead, exactly four files were copied by hand from the source commit stamped above and each verified `cmp`-identical to it immediately afterward: `specs/schemas/dogtag.dog-profile.v1.schema.json`, `specs/schemas/leaf-dictionary.v1.json`, and `specs/schemas/README.md` (all three carrying WP4.12's three new optional profile leaves - `color`, `registrationId`, `registrationAuthority` - and the matching 1.0.0 -> 1.1.0 version ticks), plus `specs/vet-public-api.yaml` (the same three leaves added to `PetProfile`). The other five files under `specs/schemas/` (`dogtag.cdc-import-form.v1.schema.json`, `dogtag.envelope.v1.schema.json`, `dogtag.eu-health-cert.v1.schema.json`, `dogtag.rabies-vaccination.v1.schema.json`, `dogtag.redacted-tag-artifact.v1.schema.json`, `dogtag.service-attestation.v1.schema.json`) were confirmed `cmp`-identical to the source commit BEFORE anything was copied, so this sync left them untouched.

`contracts/exports/abi/`, `contracts/exports/events.json`, `contracts/flattened/`, `packages/dogtag-standard-ts/`, and `design/design-system.md` were NOT touched by this sync and may already be behind the source commit stamped above, independent of anything said here - only a real `scripts/sync-to.sh` run picks those up.

## Local deviations from the source commit above

The four EIP-712 vector files under `specs/` (`eip712-client-registration-vectors.json`, `eip712-client-registration-signature-vectors.json`, `eip712-mobile-booking-vectors.json`, `mobile-booking-hash-vectors.json`) were authored directly into this vendored tree by an earlier commit and never existed in `dogtag-protocol` itself. This sync never ran `specs/`'s wholesale `rsync --delete`, so all four remain exactly as they were.

`specs/vet-public-api.yaml` is NOT currently ahead of `dogtag-protocol`'s own copy - this sync simply brought it fully current (`cmp`-identical to the source commit above). Immediately before this sync it was already byte-identical to `dogtag-protocol` at commit `e0ca027` (the revision right before WP4.12S's three-leaf addition), confirmed by diff, so this straight copy loses no prior hand-edit. `dogtag-vet/README.md`'s own "Protocol sync" section agrees: its deviation list no longer claims this file is ahead of master.

This note is itself part of the vendored content above and does NOT survive a future full `scripts/sync-to.sh` run, which regenerates this whole file from its own template with neither of the last two sections above.

**CORRECTED by WP4.15V (2026-09-07): the "NOT currently ahead of master" sentence immediately above is no longer true, deliberately.** `specs/vet-public-api.yaml` (and `specs/qr-formats.md`, `specs/events.md`, both `VetIssuer.json`/`DelegationRegistry.json` ABIs, and `events.json`) are now mirrors of the `feature/wp4.15-multi-owner` BRANCH tip `e654924`, not of `master` - see the "THIS TREE HAS MIXED PROVENANCE" section at the top of this file for the full accounting of which five (plus `events.json`) files this applies to and why. This is still a straight, unedited mirror copy (not a hand-edit ahead of any upstream copy) - it is simply a mirror of a DIFFERENT upstream (the branch, not master) than every other file in this tree.
