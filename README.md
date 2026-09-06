# dogtag-vet

A self-deployable vet-clinic platform built on the DogTag protocol.
Client and pet records, appointment scheduling, DogTag issuance and verification, and crypto-and-fiat invoicing, all in one Next.js app plus a background worker.

## Stack

- Next.js 15 App Router, TypeScript strict, standalone output.
- Tailwind CSS with the shared DogTag design tokens (`src/app/globals.css`).
- mongoose 8 against a single MongoDB deployment.
- Auth.js v5 (Google, email magic link; a dev-only credentials sign-in behind `DEV_LOGIN=1`, never for production).
- wagmi v2 + viem for every on-chain read and write; no server-held private keys anywhere.
- A separate worker process (`pnpm worker`) for the chain-activity follower, the payment watcher, and boot recovery.
- The vendored `protocol/packages/dogtag-standard-ts` for every leaf/merkle/disclosure crypto operation - never reimplemented in this repo.

## Local development

```
pnpm install
pnpm dev
```

Set `DEV_LOGIN=1` to enable the dev-only credentials sign-in (first user becomes `owner`, later ones `staff`).
This provider is documented as dev/test-only and must never be enabled in a production deployment.

Google and email-magic-link sign-in are invite-gated: the very first person to sign in on a fresh deployment becomes `owner`, and every email after that must be invited from Settings > Staff access by an existing owner before it can sign in at all.
An uninvited email is refused outright, not silently granted a `staff` account.

## Test commands

```
pnpm build        # production build
pnpm lint         # eslint
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest unit suite
pnpm test:e2e     # Playwright smoke (needs a running docker mongo)
pnpm worker       # the background worker process
```

## Deployment

`docker compose up -d` after copying `.env.example` to `.env` and filling in the values it marks REQUIRED is the fastest path to a running clinic instance.
See `docs/DEPLOY.md` for the full quickstart, the Kubernetes path (`helm/dogtag-vet/`), a managed-Mongo option, a `cloudflared` tunnel option for clinics with no static IP, Cloudflare and nginx rate-limiting guides for the public API surface, and backup guidance.

## Protocol sync

`protocol/` is vendored by `dogtag-protocol/scripts/sync-to.sh`, which mirrors `contracts/exports`, `contracts/flattened`, `packages/dogtag-standard-ts`, `specs/`, and `design/design-system.md` wholesale (`rsync --delete`) and regenerates `protocol/PROVENANCE.md` from scratch every time.
It holds the contract ABIs, the wire-authoritative OpenAPI spec (`protocol/specs/vet-public-api.yaml`), the QR and issuer-attestation format specs, and the `@dogtag/standard` crypto library, wired in as a pnpm workspace package.

**Local deviations the sync does not preserve** (re-apply by hand after every re-sync, since `PROVENANCE.md`'s own generated text is overwritten wholesale and cannot carry this note itself):
1. The four EIP-712 vector files under `protocol/specs/` (`eip712-client-registration-vectors.json`, `eip712-client-registration-signature-vectors.json`, `eip712-mobile-booking-vectors.json`, `mobile-booking-hash-vectors.json`) were authored directly into this app's vendored tree by an earlier commit and never existed in `dogtag-protocol` itself - at least 8 of this repo's own test files depend on them. A re-sync deletes all four outright (`git checkout --` restores them from this repo's own history immediately after, since they are tracked here). Relocating them to a proper, non-vendored home is a follow-up, not yet done.

So "nothing in this app should ever need to change what lives inside it" is no longer quite true: exactly one thing does, by design, and needs re-applying after every re-sync until the vector files move out of `protocol/` for good. (`protocol/specs/vet-public-api.yaml` was hand-edited ahead of master through WP4.9V/WP4.10V, but WP4.12V's item 1 brought it fully current - see `protocol/PROVENANCE.md` - so it is a plain mirror today, not a standing deviation; if a future wave hand-edits it ahead again before the next upstream sync, restate this as a conditional, not as present fact.)

## Tag data custody

Every DogTag profile tree this clinic ever custodies - one it issued itself, or one it received from another clinic (a mobile booking's tag claim, or the dedicated export/import ceremony below) - is stored as a `TagArtifact` (`src/lib/models/TagArtifact.ts`).
Each row holds the leaves this clinic actually holds an opening for, the hashes of any leaves it holds only as opaque commitments (`obfuscatedLeafHashes` - non-empty only when this artifact arrived already masked by its owner, see "Masking" below), the three reserved owner-control leaf hashes, the on-chain root they all fold to, the schema registry `$id` the record type was issued or received against (`schemaId`), which protocol version they were verified under, and where this row came from (`source: "issued_here" | "imported"`).

**Verify-at-write, never verify-at-read.**
`src/lib/tags/artifact.ts`'s `createTagArtifact` is the ONE write path onto this collection.
Every caller - the custodial-bind terminal write, the WP4.4 mobile-booking tier-4 import, and the export/import ceremonies below - goes through it, and it runs `verifyRedactedArtifact` against the claimed root before ever inserting a row.
An ordinary, fully-disclosed artifact is that same check's degenerate case (`obfuscatedLeafHashes: []`), so this is a strict generalization of the original leaf-commitment check, not a parallel code path.
A `TagArtifact` existing at all is therefore itself the proof its leaves (and, if any, its obfuscated hashes) recompute its root; nothing downstream (the export ceremony, the pet page) re-verifies on read.

**Version dispatch.**
`protocolVersion` is looked up in a small table (`PROTOCOL_VERIFIERS` in `artifact.ts`) that maps a version string to the recompute function to use for it - today exactly one entry (`dogtag-v2/1` -> `verifyRedactedArtifact`), since the leaf-commitment crypto itself is frozen (`dogtag-protocol/specs/leaf-commitment.md` section 12).
An artifact whose `protocolVersion` is not in that table is refused outright, never silently accepted - a future protocol version needs a new table entry before this app will ever store one under it.

**Masking (selective disclosure by obfuscation)**, per `plans/wp4.10-masked-export.md`, lets an owner or clinic withhold individual attribute values from a specific export while the root still recomputes identically.
Any attribute leaf - including `owner.identity.*` - may be masked; the only structural invariant is the reserved triple (exactly 3, never maskable, disclosable, or relabeled - `dogtag-protocol/specs/leaf-commitment.md` section 15 rules that the non-maskable set beyond that triple is EMPTY).
A masked leaf survives only as its hash, recomputed server-side from the real opening and never trusted as a stored value (`verifyRedactedArtifact`'s own contract) - masking a field can never be detected as tampering by any reader that implements `verifyRedactedArtifact` and honors `obfuscatedLeafHashes`. A reader that only understands the older, leaves-only shape (the shipped phone client decodes `leaves` this way today - see "Export ceremony" below) cannot rebuild the root from a masked export at all, so it will not verify one; that is a limitation of that reader, not something this app's own masking hides.
Staff pick which fields to mask from a pet's page ("Export with masking") or the `/tags` row action: a field picker over the active artifact's own disclosed leaves grouped by pet attribute vs. owner identity, a live preview showing exactly what a masked field becomes, and three actions (Download JSON, Show QR, Copy JSON) that all produce the same `RedactedTagArtifact`-shaped payload for the checked mask.
A field this clinic already holds only a hash for (partial custody, from having imported an already-masked artifact) can never be picked to unmask - there is no opening to disclose - and is surfaced separately as a count, never invented.

**Export ceremony** (`plans/wp4.9-tag-data-custody.md` section 2.2; wire format in `plans/wp4.10-masked-export.md` section 2) lets staff hand a pet's already-custodied data to its owner's phone without a chain write.
`POST /api/pets/:id/export-tag-data` creates a one-time, 10-minute session for the pet's currently-active artifact, optionally validated against a `mask: string[]` of keyPaths to obfuscate; the owner's app scans the resulting QR and calls `GET /e/:token`, which atomically consumes the token and returns a `RedactedTagArtifact` in one step - there is no separate resolve/complete split, since the phone only ever reads.
The response's opened leaves are served under `disclosed` (the canonical field) and, identically, under `leaves` (a DEPRECATED alias kept only because WP4.9M's shipped phone client decodes that exact key as required today - removing it is a follow-up the WP4.10M wave owns, once every consumer reads `disclosed` instead).
A second fetch of the same token, or a fetch after the tag was revoked or replaced, is refused (`410`).

**Import ceremony** (section 2.3) is the reverse: a pet's data arrives from elsewhere.
Staff picks a target (an existing pet, or "create new from verified data") and generates a QR (`POST /api/tags/import-sessions`); the owner's app resolves it (`GET /i/:token`) and posts its tag's `dogTagIdDec`/`dogTagIdField` plus either `leaves` (the pre-masking shape) or `disclosed` and any `obfuscatedLeafHashes` (the masked shape) back (`POST /i/:token/complete`) - a body sending both `leaves` and `disclosed` is accepted only if they agree, and rejected outright if they differ.
That completion re-runs the exact same chain-verification gates the WP4.4 booking import uses (`src/lib/tags/verifier.ts`) - dec/field consistency, a LIVE `profileRoot` read (never a client-supplied root, which is what makes a reinstated-after-revocation or replaced-root tag "just work" on a fresh scan), issuer validity, and `verifyRedactedArtifact` - before attaching anything.
An import that arrives already masked stores honest PARTIAL custody: the pet page shows a "masked by the owner" count (never a keyPath - genuinely unknown to this clinic), and a field is only ever filled in from a value this clinic actually received, never invented from a hash.
A previously-empty field the clinic DID receive a value for is filled from the verified data; a field that already had a different value is kept exactly as the clinic had it and surfaced instead on the pet page as a conflict, timestamped to when the import happened.
Both ceremonies' tokens are one-shot, burned on every outcome (success or refusal) - there is no retry endpoint for either, the same "generate a fresh one" convention this app's other ceremonies (mint, wallet registration) already use.

**Verifying a redacted artifact independently** (`/verify/redacted`, staff-only) checks an arbitrary pasted or uploaded `RedactedTagArtifact` JSON document - not necessarily one this clinic ever custodied - against the same crypto and chain-binding pipeline (`src/lib/tags/verifyRedactedFlow.ts`).
The result is never a bare true/false: cryptographically broken or internally inconsistent, chain-unreadable, chain-anchored-but-never-issued, chain-anchored-to-a-different-root, chain-anchored-with-no-indexed-issuer, and verified (itself split into currently-valid vs. currently-revoked) are all reported as distinct, honestly-labeled outcomes, alongside which keyPaths the document discloses and how many it masks.

**Schema stamping and backfill repair.**
Every artifact this app writes now stamps `schemaId` (`src/lib/tags/schemaIds.ts`'s `DOG_PROFILE_SCHEMA_ID`, the one record type this app has ever custodied) - the custodial-bind write, the WP4.4 booking tier-4 import, and the fresh-insert backfill path below all stamp it at write time.
A clinic with historical rows from before this stamping existed can repair them in place with `pnpm backfill-tag-artifacts --repair-schema-id --dry-run` (report only - lists which rows would be stamped, writes nothing), then the identical command with `--write` in place of `--dry-run` to apply it - the script refuses to run with neither flag (or both), never guessing a default in either direction, so always run the `--dry-run` form first and read its report before the `--write` form. Idempotent (only ever fills a genuinely-absent `schemaId`, never overwrites an existing one) and safe to re-run - a second `--write` run reports zero rows left to stamp.

**Existing-deployment backfill.**
A clinic that adopted this schema after already having issued or imported tags needs a one-time pass to give its historical pets a `TagArtifact` row - the backfill script (`scripts/backfillTagArtifacts.ts`, aliased as `pnpm backfill-tag-artifacts`) exists for exactly this and documents its own `--dry-run`/`--write` usage in its header comment; a fresh deployment needs no action, since every tag issued or imported from this schema onward already creates its own `TagArtifact` automatically.

## Vet wallet self-registration and whitelist status

Kenneth's ask (K2): a vet or owner should be able to register their own wallet address themselves, not only have an owner assign it for them, and every issuance surface should tell them plainly whether that address can actually issue on chain - never a guess, never a false "whitelisted".

**Self-service (`/settings`'s "My issuance wallet" card, any vet/owner session).**
`PATCH /api/settings/staff/me/wallet` (`src/app/api/settings/staff/me/wallet/route.ts`) lets a vet or owner set or clear THEIR OWN `Staff.walletAddress` - `requireVetSession` supplies the target `staffId` from the session itself, so the request body can only ever be `{walletAddress: string | null}` and can never touch another row or the caller's own role.
The card's "Use connected wallet" button fills the field from the same wagmi connected account the issuance wizard and `OperatorsSection` already use.
A manual field plus Save/Clear cover the rest.
The owner-assigns-it path (`StaffSection`'s "Practitioner profiles") is unchanged - an owner can still set or clear any vet's wallet, including their own.

**Whitelist status, everywhere it matters.**
`src/lib/issuanceOperatorStatus.ts`'s `resolveOperatorStatus` is the ONE server-side answer to "can this wallet actually issue right now" - `whitelisted`, `not-whitelisted` (the chain was asked and said no), `no-address` (nothing recorded to check), `not-configured` (this clinic's clone isn't set up yet), or `unreadable` (the chain read itself failed or timed out).
The same helper, same short (5s) cache, backs three surfaces so they can never disagree: the "My issuance wallet" card's status badge, a persistent (non-dismissible) warning banner on `/tags` and `/tags/issue` that also flags when the browser's CURRENTLY CONNECTED wallet differs from the recorded one, and `OperatorsSection`'s existing live status column (which gained one small additive "could not verify" state for an unreadable chain read - its "Active"/"Inactive" states and Add/Remove flow are unchanged).
`no-address` deliberately never claims "you cannot issue" - the chain only cares about whichever wallet is actually connected at issuance time, never this app's own record of one - that stronger claim is reserved for `not-whitelisted`, where the chain was actually asked and answered.
See `docs/DEPLOY.md`'s "Vet role, issuance operators, and per-practitioner scheduling" section for the operational procedure an owner follows to grant a vet's recorded wallet operator status on a real chain.

## Practitioner profile: first/last name, title, government accreditation

Kenneth's ask (issue 3): split a practitioner's name into first and last name, add a qualification/title field (e.g. "DVM"), and add a government accreditation number, with a UI placeholder example of "USDA accreditation number".

**Fields (`Staff.ts`).**
`firstName`, `lastName`, `title`, and `accreditationNumber` are all optional strings, each independently clearable by sending `null` (`Staff.setStaffProfile`'s `$unset` contract) - the same fix also makes the pre-existing `displayName` field clearable for the first time.
`displayName` itself is now a DEPRECATED fallback tier: legacy rows keep resolving through it until someone enters a first and last name, and there is deliberately no backfill (a whitespace split of a free-text legacy name would be a guess, and a guess written to the live database is worse than falling back to the unsplit text).

**Composition (`practitionerDisplayName` in `src/lib/staffRoleTone.ts`) - the ONE point every surface shares.**
Tier 1: `firstName`/`lastName` (either or both), with `, Title` appended when `title` is also set - e.g. "Jane Smith, DVM".
Tier 2: the deprecated `displayName`, never with a title appended (a title only ever pairs with tier 1's real name fields).
Tier 3: the email's local part - the fallback two e2e specs (`practitioner-mode.spec.ts`, `vet-wallet-status.spec.ts`) depend on for a practitioner nobody has named yet.

**Initials (`practitionerInitials`, same file) - derived from the SAME raw fields, never from tier 1's composed output.**
Splitting a composed "Jane Smith, DVM" line on whitespace picks up the title's own initial instead of the practitioner's actual last-name one - a real trap, not a hypothetical one, since `CalendarView.tsx` used to do exactly that before this WP.
`practitionerInitials` instead reads `firstName`/`lastName` directly when either is set, or falls back to the same tier-2/3 name `practitionerDisplayName` would show (with any accidentally-embedded ", trailing text" from a legacy free-text `displayName` stripped first).
`PractitionerSummary` (`src/lib/booking/queries.ts`) carries this as `initials`, computed once in `listBookablePractitioners` rather than re-derived by each UI consumer.

**Self-service (`/settings`'s "My profile" card, any vet/owner session).**
`PATCH /api/settings/staff/me/profile` (`src/app/api/settings/staff/me/profile/route.ts`) lets a vet or owner set or clear THEIR OWN first/last name, title, and accreditation number - modelled on the sibling `/me/wallet` route (`requireVetSession` supplies `staffId` from the session, `.strict()` schema with no `role`/`disabled`/`bookable`/`walletAddress` key at all).
The owner-assigns-it path (`StaffSection`'s "Practitioner profiles") is unchanged - an owner can still set or clear any vet's fields, including their own, and also sees a "Clear legacy name" action once a first/last name replaces an old `displayName`.

**The accreditation number is INTERNAL ONLY.**
It is shown and edited in Settings alone - never on the public booking wire (`GET /v1/booking/availability` maps a practitioner down to exactly `{id, name}`), the calendar, ICS, or emails.
Whether it (and the title) should ever become public is an open question left for Kenneth; the current behavior treats the title as public (part of the name line) and the accreditation number as private.

## Pet profile: optional leaves (color, government registration id, authority)

Kenneth's ask (issue 2): "add some optional fields such as local government registered id, color to the dogtag fields that form the merkle root."

**Fields.**
Three flat, optional strings under `credentialSubject.*` in the protocol's dog-profile schema: `color` (free-text coat color, e.g. "brown"), `registrationId` (a local government registration or licence id), and `registrationAuthority` (who issued `registrationId`, e.g. "AVS Singapore", so an id is never ambiguous across jurisdictions).
All three are registry-declared additions - `protocol/specs/schemas/dogtag.dog-profile.v1.schema.json` and `leaf-dictionary.v1.json` both ticked their informational `version` 1.0.0 -> 1.1.0 (same `$id`, no `leaf-dictionary.v2.json`, no protocol version bump - see that README's own versioning-rules section for why an additive keyPath is always just a minor tick).

**Where they are entered.**
`/tags/issue`'s "4. Pet profile" section (`TagIssueWizard.tsx`) gains the three inputs alongside species/breed/etc.; selecting an EXISTING pet prefills them from that pet's own CRM record (species/breed/etc. are deliberately not prefilled - unchanged, pre-existing wizard behavior).
The Pet CRM record (`PetForm.tsx`, under "Basics") carries the same three fields independently of any tag, so the vet portal's own record and a freshly issued tag's attested profile agree from the start - unlike `breedVbo`/`neuterStatus`, which exist only inside a mint session's own profile and are never mirrored onto `Pet`.

**Write-once root: already-issued tags never retroactively gain these fields.**
A `DogTag`'s profile Merkle root is fixed the moment its owner's device binds it - like every other attribute leaf, `color`/`registrationId`/`registrationAuthority` can only ever be added to a tag being minted (or re-minted via the replace flow) for the FIRST time, never edited into a tag that already has a root.
Editing the value on the Pet CRM record after issuance changes the CRM record only; it has no effect on any tag already bound, and staff should not expect the phone's own Tag data card to change without a fresh issuance.

**Import-back mapping.**
`lib/tags/verifier.ts`'s `mapVerifiedLeavesToPetAttributes` reads the three keyPaths the exact same way as every other string attribute; `lib/tags/importFlow.ts`'s fill-empty-only merge (`mergeVerifiedAttributes`) treats them identically to `species`/`breed`/`dateOfBirth` - an empty field on the target pet is filled from the verified claim, a differing value is kept and surfaced as a conflict, never silently overwritten.

**The WP4.4 mobile-booking external-pet path carries them too (WP4.12V fix round 1, D3).**
`lib/booking/postBooking.ts`'s `CreateExternalPetInput` (the provisional pet record created when a mobile booking claims a foreign clinic's tag) gains `color`/`registrationId`/`registrationAuthority` alongside the four sibling attributes it already carried, and `lib/booking/mobileMongoAdapters.ts`'s `createExternalPet` writes them onto the created `Pet`. This was originally left out on the theory that these provisional ("external") records are invisible to the vet - that theory was wrong: `Pet.dogTag.external`'s own doc comment on `src/lib/models/Pet.ts` scopes the exclusion precisely to "this clinic's own tags/issuance surfaces (`/tags`, `/tags/issue`)" - it says nothing about the general Pets pages. An external pet appears in the Pets list and opens its own detail page like any other (`src/app/(app)/pets/page.tsx` and `.../pets/[id]/page.tsx` apply no `external` filter at all), so a verified color/registration id/authority the shared `mapVerifiedLeavesToPetAttributes` already computes belongs on that record exactly like species/breed/sex/dateOfBirth, the four fields this path was already carrying.

## Design decisions

### Invoice PDF library: pdfkit

wp4-vet.md asks for a choice between `pdfkit` and `@react-pdf/renderer`, justified here.

`pdfkit` was chosen because invoice generation in this app (`src/lib/payments/pdf.ts`) is a plain data-to-document transform - line items, totals, a QR image - with no need for a JSX component tree, CSS-like layout, or React's reconciliation model.
`pdfkit`'s imperative, stream-based API (`doc.text(...)`, `doc.image(...)`, `doc.moveDown()`) maps directly onto that kind of document and produces a `Buffer` with no intermediate render step, which fits both of this app's PDF call sites equally well: a route handler streaming a response, and a background email job attaching the same buffer.
`@react-pdf/renderer` is a better fit when a PDF's layout is itself complex and benefits from JSX composition and reuse across many document types; this app has exactly one document shape (the invoice/receipt), so that composability was not worth the extra dependency (a full React renderer distinct from the app's own React tree) or its own font-loading quirks under a bundled Node runtime.

`pdfkit` loads its font metrics from disk at runtime rather than at bundle time, so it is marked in `next.config.ts`'s `serverExternalPackages` (alongside the vendored crypto packages) rather than left for webpack to inline - inlining it would relocate that file lookup away from the package's real directory and break PDF generation at request time with the build still green.
`tests/unit/pdf.test.ts` guards against exactly that regression by asserting a real, non-trivial PDF buffer comes out, not just that the code compiles.

### Why the web Docker image copies a full `node_modules`, not just the standalone output

Next's `output: "standalone"` traces each route's dependencies and copies only the files it finds into `.next/standalone/`, which is normally a large size win.
It cannot fully resolve `@dogtag/standard`, though: that package is ESM-only (`"type": "module"`, no `require` export condition), so the tracer's static analysis gives up after finding its `package.json` and never copies `dist/` or walks into its own dependencies (`circomlibjs`, in turn depending on `ethers` and others).
That is not a narrow gap - `circomlibjs` is imported at the top of `consent.js`, which the package's entry point re-exports unconditionally, so it would break `import` of `@dogtag/standard` entirely, i.e. every mint and verify route, in any container built from the standalone output alone.
This was caught by actually inspecting `.next/standalone/` after a real build and by running the built image against a real Mongo container (see the Definition of Done's Docker-build step) - a green `pnpm build` gives no signal of it, since `pnpm dev` and `pnpm start` both run against the full local `node_modules`, never the standalone tree.

`Dockerfile`'s runner stage works around this by copying the complete, really-`pnpm install`-resolved `node_modules` and `protocol/` directories over whatever the standalone tracer produced at those two paths, rather than trying to hand-list `ethers`'s own transitive dependency closure in `next.config.ts`.
It costs image size in exchange for being unconditionally correct; `next.config.ts` carries the fuller explanation and `pdfkit`'s narrower, unrelated version of the same class of problem (its `.afm` font-metrics files, fixed there with `outputFileTracingIncludes` instead, since that gap is self-contained and also affects non-Docker deployments of the standalone output).

### Payment-view vs. receipt tokens

Every invoice carries two distinct bearer tokens, both unguessable and generated once at creation.

`Payment.viewToken` gates the public status page (`/pay/{id}?token=...`) and the wire-spec `GET /v1/payments/{id}/public` endpoint.
It works before and after payment, and is meant to be shared with the client alongside the invoice.

`Payment.receiptToken` gates the wire-spec `GET /r/pay/{receiptToken}` endpoint, which is printed as a QR code on the invoice PDF itself.
Per `specs/vet-public-api.yaml` and `specs/qr-formats.md`, that endpoint returns the receipt PDF directly and only once the payment is `paid` - scanning it before that returns a 404, by design, since there is no receipt yet to serve.
The public status page offers its own "download invoice" link (unstamped, working at any time) precisely so a client has something to download before that point.
