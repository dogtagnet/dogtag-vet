# Vendored from dogtag-protocol

Source commit (this sync, WP4.14V V0): `feature/wp4.14-records` branch, `dogtag-protocol` worktree at `/Users/zhenhaowu/code/dogtag/worktrees/dogtag-protocol-wp414`, commit `bd1874c0490be20a0641cabc02456630f0960f5d` (short `bd1874c`, WP4.14S accepted tip, fix round 1 N2).
Synced at: 2026-09-06T23:38 SGT.
Synced by: WP4.14V builder (targeted re-mirror from a FEATURE BRANCH, not mainline, and NOT `scripts/sync-to.sh` - see "Scope of this sync" below).

This supersedes the prior header (WP4.12V, mainline commit `70d8078`, 2026-09-06T13:43:36Z) for the files this sync touched.
See git history on this file for that sync's own full note.

**Grade round 1 D6 (NIT, accuracy)**: this header's own "Source commit" line above names `bd1874c`,
but two files under `specs/` have since been re-vendored past that point and no longer match it:
`specs/qr-formats.md` and `specs/vet-public-api.yaml` were re-vendored by V7 (vet commit `705aeca`,
protocol commit `0173d71`), its follow-up (vet `074c24a`, protocol `8ac6299`), and again by FIX ROUND
1's D1 + biometric-sentence work (vet `6830508`, protocol `cfc0835`) - those two files now mirror
protocol tip `cfc0835e98e24a4f35c5cbb87b4c2d69f94b281d`, not `bd1874c`. `specs/leaf-commitment.md`
was ALSO re-vendored by that same fix-round-1 commit (D1's new validity states) and now mirrors
`cfc0835` too. Every other file this document lists below - the vendored TS package's `src/`/`test/`
and every other spec file - is still genuinely at `bd1874c`, confirmed by `cmp` against that commit
each time a re-vendor has touched only the files named above. `packages/dogtag-standard-ts/dist/` is
excluded from this commit-pinning discussion by its own nature: it is a rebuilt artifact of
whatever `src/` currently is (see "Rebuilt via `pnpm --filter @dogtag/standard build`" below), not a
byte-for-byte vendored copy pinned to one commit the way every file listed above is.

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

## Scope of this sync (WP4.14V V0 - targeted, not a full `scripts/sync-to.sh` run)

Plan section 11.2 item V0 scopes this wave's re-mirror to "protocol/specs/* and the vendored TS package from the protocol branch," standard source = the protocol BRANCH worktree at `bd1874c` (not `dogtag-protocol` mainline).
This did NOT run `scripts/sync-to.sh`, for the same reason WP4.12V's sync did not: that script's `specs` sync is `rsync -a --delete`, which would delete the four EIP-712 vector files named below that exist only in this vendored copy and never existed upstream at all.

Before copying anything, this sync confirmed the branch is safe to pull from wholesale for the files below: `dogtag-protocol` mainline moved from `7709a4a` (the branch's own base) to `70d8078` (the commit WP4.12V last vendored from) via exactly two commits, `403ce85` and `70d8078`, and `git diff --stat 7709a4a..70d8078` touches only `docs/architecture-v2.md` and `specs/events.md` - neither of which this sync (or WP4.12V's) ever vendors from at file granularity in a way that would regress.
So for every file this sync actually touches, the branch and mainline agree as of the branch's own base; pulling from the branch tip adds exactly WP4.14S's own commits on top, with nothing lost.

Exactly the following were copied from the branch worktree at `bd1874c` and each verified `cmp`-identical to it immediately afterward:

- `specs/leaf-commitment.md` (new section 16, record artifacts)
- `specs/leaf-commitment-vectors.json` (new `recordArtifactVectors`)
- `specs/qr-formats.md` (artifactType tag|record note)
- `specs/schemas/README.md`
- `specs/schemas/dogtag.record-artifact.v1.schema.json` (new file)
- `specs/schemas/dogtag.vaccination.v1.schema.json` (new file)
- `specs/schemas/leaf-dictionary.v1.json` (new WP4.14S entries: issuer.chainId/contract/operator, credentialSchema.version, targetDisease, doseQuantity, and reused rabies-era keyPaths now also usable by a VACCINATION record)
- `specs/standards/` (new directory, whole: `index.yaml`, `README.md`, `hl7-fhir-immunization/r4.yaml`, `nasphv-form51/2007.yaml`, `eu-pet-passport/577-2013-annex-iii-v.yaml`)
- `specs/vet-public-api.yaml` (new `RecordArtifact`/`RecordAnchoring` components; `ArtifactExportResponse` gains `artifactType`, restructured `allOf`/`if`/`then`/`else` per fix round 1 D3)
- `packages/dogtag-standard-ts/scripts/promote-spec-vectors.ts`
- `packages/dogtag-standard-ts/src/index.ts` (re-exports `recordArtifact.js`)
- `packages/dogtag-standard-ts/src/recordArtifact.ts` (new file - `RecordArtifact`, `verifyRecordArtifact`, `RECORD_NON_MASKABLE_KEY_PATHS`)
- `packages/dogtag-standard-ts/src/redactedArtifact.ts` (fix round 1 D2's `isMalformedSaltHex` guard; test-only additions from the advisor round)
- `packages/dogtag-standard-ts/src/verify.ts` (the `issuerRecordTypeOfRoot`/`recordTypeOf(root)` whitelist-pillar adapter, `issuerRecordType` demoted to fallback - see "Local deviations" below for why this is a no-op for this app)
- `packages/dogtag-standard-ts/test/recordArtifact.test.ts` (new file)
- `packages/dogtag-standard-ts/test/record_artifact_schema.test.ts` (new file)
- `packages/dogtag-standard-ts/test/redacted_artifact.test.ts`
- `packages/dogtag-standard-ts/test/schema_registry.test.ts`
- `packages/dogtag-standard-ts/test/spec_vectors.test.ts`
- `packages/dogtag-standard-ts/test/vaccination_schema.test.ts` (new file)
- `packages/dogtag-standard-ts/test/verify_orchestration.test.ts`

Every `.json` and `.yaml` file under `specs/schemas/` NOT in the list above (`dogtag.cdc-import-form.v1.schema.json`, `dogtag.dog-profile.v1.schema.json`, `dogtag.envelope.v1.schema.json`, `dogtag.eu-health-cert.v1.schema.json`, `dogtag.rabies-vaccination.v1.schema.json`, `dogtag.redacted-tag-artifact.v1.schema.json`, `dogtag.service-attestation.v1.schema.json`) was confirmed `cmp`-identical to the branch's copy BEFORE anything was touched, so this sync left them alone.

`contracts/exports/abi/VetIssuer.json` was checked (not copied): it already exposes `issueRecord`, `revokeRecord`, `reactivateRecord`, `recordTypeOf`, and `RECORD_TYPE_VACCINATION` in this vendored copy, byte-identical to the branch's own `contracts/exports/abi/VetIssuer.json` - WP4.14S touched no contract source (plan section 2's "SAME CONTRACT, zero opcode differences" finding predates this whole wave), so there was nothing to re-vendor here.

`specs/vet-public-api.yaml` is NOT currently ahead of `dogtag-protocol`'s own copy - this sync simply brought it fully current (`cmp`-identical to the source commit above). Immediately before this sync it was already byte-identical to `dogtag-protocol` at commit `e0ca027` (the revision right before WP4.12S's three-leaf addition), confirmed by diff, so this straight copy loses no prior hand-edit. `dogtag-vet/README.md`'s own "Protocol sync" section agrees: its deviation list no longer claims this file is ahead of master.

`contracts/exports/abi/` (other files), `contracts/exports/events.json`, `contracts/flattened/`, and `design/design-system.md` were NOT touched by this sync and remain exactly as WP4.12V (or earlier) left them - only a real `scripts/sync-to.sh` run picks those up.

## Rebuild

`packages/dogtag-standard-ts/dist/` is tracked in this repo and must be rebuilt after any source sync (WP4.10V fix round 1 D4's own lesson: a stale `dist` fails silently).
Rebuilt via `pnpm --filter @dogtag/standard build` (`tsc -p tsconfig.json`) from this repo's root immediately after the copy above; verified the new symbols actually cross the package boundary (`node -e "import('./protocol/packages/dogtag-standard-ts/dist/index.js').then(m => console.log(typeof m.verifyRecordArtifact, m.RECORD_NON_MASKABLE_KEY_PATHS))"` - printed `function` and the 7 non-maskable keyPaths).
This app's own `pnpm exec tsc --noEmit`, `pnpm lint`, and `pnpm test` (1203/1203) were re-run clean immediately after the rebuild.

Note: this repo's own `vitest.config.ts` scopes discovery to `tests/unit/**/*.test.ts` specifically so the vendored package's own `test/**` suite is never picked up by `pnpm test` here (see that file's own doc comment).
The vendored package's `pnpm test`/`pnpm --filter @dogtag/standard test` scripts do not run standalone inside this nested pnpm workspace either (vitest's config resolution walks up to this repo's own root `vitest.config.ts`, which excludes the package's `test/` directory) - this is a pre-existing property of vendoring a vitest-based package into a parent vitest workspace, not something this sync introduced or could fix without adding a vet-only config file to a "do not edit" tree.
The vendored suite (645/645 TS, per `wp4.14-vaccination-records.md` section 12.4) was independently verified on the protocol branch itself before this sync (`wp4.14S-progress.md`, `wp4.14S-grade.md`), and every file this sync copied was `cmp`-verified byte-identical to that already-accepted source - this app relies on that verification plus the crossing-the-boundary smoke test above, rather than re-running the vendored suite a second time inside a workspace it was never designed to run in.

## Local deviations from the branch commit above

The four EIP-712 vector files under `specs/` (`eip712-client-registration-vectors.json`, `eip712-client-registration-signature-vectors.json`, `eip712-mobile-booking-vectors.json`, `mobile-booking-hash-vectors.json`) were authored directly into this vendored tree by an earlier commit and never existed in `dogtag-protocol` itself.
This sync never ran `specs/`'s wholesale `rsync --delete`, so all four remain exactly as they were.

`packages/dogtag-standard-ts/src/verify.ts`'s new `issuerRecordTypeOfRoot`/`issuerRecordType` (`RpcAdapter`) methods are a BREAKING interface change (WP4.14S deviation 7/D6) with no production implementor anywhere.
This app has no implementor of `RpcAdapter` at all (grepped: nothing in `src/` imports `verify.ts` or implements that interface - this app's own chain-pillar checks are the bespoke, lighter `lib/tags/verifier.ts` orchestration built directly on `lib/chainRead.ts`, not `verify.ts`'s `checkIntegrity`/`RpcAdapter`), and this repo's own `tsconfig.json` excludes `protocol` entirely from typecheck - so the breaking change is a complete non-event here, for both the app and its test suite.

`specs/vet-public-api.yaml` is not currently ahead of the branch's own copy - this sync brought it fully current (`cmp`-identical to `bd1874c`).
WP4.14V item V7 will add new record-verify-session endpoints on top of this in a later commit, mirrored back into this file - see that commit's own message for the resulting protocol-branch commit hash.

This note is itself part of the vendored content above and does NOT survive a future full `scripts/sync-to.sh` run, which regenerates this whole file from its own template with none of the hand-written sections above.
