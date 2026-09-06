# Vendored from dogtag-protocol

Source commit: 70d8078429b17834510c80fa44669b748aaa2fbd
Source commit (short): 70d8078
Synced at: 2026-09-06T13:43:36Z
Synced by: WP4.12V builder (targeted re-mirror, NOT `scripts/sync-to.sh` - see "Scope of this sync" below)

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
