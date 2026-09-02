# Vendored from dogtag-protocol

Source commit: f270b45f590744f79dbdbf6f83bae9ee77a7815e
Source commit (short): f270b45
Synced at: 2026-09-02T22:48:53Z
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

## Local deviations from the source commit above (WP4.10V fix round 1, D4)

This copy is not a pure mirror of the source commit stamped above: `specs/vet-public-api.yaml` is hand-edited ahead of it (this app's own wire changes, precedent WP4.9V), and 4 EIP-712 vector files under `specs/` were authored directly into this vendored tree and never existed upstream at all.
Both are restored/re-applied by hand immediately after every sync, including this one.
This note is itself part of the vendored, wholesale-regenerated content above and does NOT survive the next sync (`sync-to.sh` writes this whole file from a template, this section included) - the durable record, which a re-syncer should read FIRST, lives in `dogtag-vet`'s own `README.md` under "Protocol sync".
