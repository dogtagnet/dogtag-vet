# Vendored from dogtag-protocol

Source commit: 403faea772b2fd3f13d452832187eacbfeff4375
Source commit (short): 403faea
Synced at: 2026-09-20T19:01:00Z
Synced by: scripts/sync-to.sh

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
