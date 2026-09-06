# DogTag QR payload formats

This document lists every QR payload in the DogTag ecosystem, its exact grammar, and how a scanner must parse it.
Every payload is a plain URL or URI a general-purpose camera app already knows how to open, so a device without the DogTag app installed still opens something.
The payment URIs typically hand off to the user's own wallet app (see "Payment QR" below), but every `https://<vet>/...` payload in this document is a bare API route with no HTML page behind it, so a plain browser just sees that route's raw response instead of a designed screen - JSON for every session-token ceremony, the receipt PDF itself for `/r/pay`.

## The token grammar

This section covers the mint, verify, wallet-registration, tag-export, tag-import, and records-verify session tokens.
The receipt token has its own, deliberately different grammar; see "Receipt URL" below.

Every mint, verify, wallet-registration, tag-export, tag-import, or records-verify session token in this ecosystem is 32 lowercase hexadecimal characters: `^[0-9a-f]{32}$`.
That is 128 bits of entropy, base16-encoded, always lowercase on the wire.
A parser MUST reject a mint, verify, wallet-registration, tag-export, tag-import, or records-verify token that is the wrong length, contains uppercase hex digits, or contains any character outside `[0-9a-f]`, rather than attempting to normalize it.
This grammar is v1-compatible: a v1 QR and a v2 QR use the same token shape, so a mixed fleet of old and new vet deployments during a migration window still produces scannable codes.

## Mint QR

```
https://<vet>/p/<32hex>
```

- `<vet>` is the vet platform's own host, exactly as served from its `platformBaseUrl` in the admin directory (`specs/admin-public-api.yaml`).
- `<32hex>` is the mint-session token, matching the grammar above.
- Resolves via `GET /p/{token}` in `specs/vet-public-api.yaml`.
- Printed or displayed by vet staff when opening a mint session for a pet; scanned by the owner's mobile app.
- Non-consuming: the same code can be rescanned until the owner posts `POST /profiles/issue/custodial-bind`, which is the action that consumes the token.

### Parsing rules

1. The scheme MUST be `https`.
2. The path MUST match `^/p/[0-9a-f]{32}$` exactly, with no trailing slash, query string, or fragment.
3. A scanner that recognizes the host as a known DogTag deployment (or recognizes the `/p/` shape generically) should open the app directly; otherwise it should fall through to a normal browser open - `/p/{token}` is a bare API route (`GET /p/{token}` in `specs/vet-public-api.yaml`) with no HTML page behind it, so a plain browser just sees that route's raw JSON: the resolve body on success, an error body otherwise.

## Verify QR

```
https://<vet>/x/<32hex>?a=<relayer>
```

- `<vet>` and `<32hex>` as above, but naming a verify (consent) session rather than a mint session.
- `<relayer>` is the requesting relayer's on-chain address, `0x`-prefixed, 40 hex characters, case-insensitive on the wire (compared case-insensitively by every consumer).
- Resolves via `GET /x/{token}` in `specs/vet-public-api.yaml`; `a` is surfaced to the owner as which relayer is asking, before any proof is built.
- The owner's device never sends `a` back verbatim as authority: `GET /x/{token}` returns the session's own `relayer` field, which is what the consent proof's `pubSignals[2]` must equal, and a scanner MUST treat the response body, not the QR's `a` parameter, as the value to prove against.
  The QR's `a` exists only so the app can show "requested by `<relayer>`" before the network round trip completes.

### Parsing rules

1. The scheme MUST be `https`.
2. The path MUST match `^/x/[0-9a-f]{32}$`.
3. The query string MUST contain exactly one `a` parameter, matching `^0x[0-9a-fA-F]{40}$`; a scanner that finds additional unknown query parameters ignores them rather than rejecting the code (forward compatibility for a future optional hint), but MUST NOT ignore a missing or malformed `a`.

## Wallet registration QR

```
https://<vet>/w/<32hex>
```

- `<vet>` and `<32hex>` as above (same token grammar as mint and verify).
- Resolves via `GET /w/{token}` in `specs/vet-public-api.yaml`; submitted via `POST /w/{token}/complete`.
- Printed or displayed by vet staff from a client's detail page ("Register wallet") to bind the owner's wallet address to that client record for bookkeeping; scanned by the owner's mobile app.
- Non-consuming resolve, consuming complete: `GET /w/{token}` only returns the EIP-712 challenge (clinic name, masked client name, and the struct fields the app will sign) and can be safely retried.
  `POST /w/{token}/complete` is the action that consumes the token, on every outcome, success or refusal alike - a burned token is simply dead, and there is no retry endpoint for this ceremony.
- Error states: `GET /w/{token}` refuses with `404` (`not_found`: unknown or malformed) or `410` (`expired_or_reused`: already consumed by a prior success or failure, or naturally expired) before the owner ever sees the consent screen.
  `POST /w/{token}/complete` additionally refuses with `400` (`signature_invalid`: a malformed request body, or a recovered signer that does not equal the claimed wallet) or `409` (`already_registered`: this wallet is already registered to this client), on top of the same `404`/`410` above.
  Every `POST` outcome consumes the token, including a failed `signature_invalid` attempt, so a fresh attempt needs a fresh QR from the clinic.
- Fixed TTL: 600 seconds from creation, not extended by resolving, like the export and import ceremonies below and unlike the mint QR's TTL-extension-on-first-resolve.
- On a successful scan, the app calls `GET /w/{token}` for the challenge, then shows a consent screen (clinic name, masked client name, and the wallet address about to be registered) before doing anything else.
  Only after the owner passes a biometric gate does the app build the `ClientRegistration` EIP-712 struct from the challenge's own server-chosen fields plus the wallet being registered, sign it with that wallet's key, and `POST` the wallet address plus signature to `/complete`.
  The server independently rebuilds the exact same domain and struct from its own server-trusted session state and recovers the signer - the request body's claimed wallet (itself part of the signed struct) is trusted only once that recovered signer is proven to equal it.
- The app calls both `GET /w/{token}` and `POST /w/{token}/complete` against the exact host parsed from the QR, never a host it already has stored or discovered for a clinic of the same name ("scanned host only" - the same rule every vet-facing ceremony in this catalogue follows).

### Parsing rules

1. The scheme MUST be `https`.
2. The path MUST match `^/w/[0-9a-f]{32}$` exactly, with no trailing slash, query string, or fragment.

## Export QR (device recovery)

```
https://<vet>/e/<32hex>
```

- `<vet>` and `<32hex>` as above (same token grammar as mint and verify).
- Resolves via `GET /e/{token}` in `specs/vet-public-api.yaml`.
- Printed or displayed by vet staff to hand a pet's currently-active tag data back to its owner's phone.
  This is device recovery: a new phone, or a phone that lost its locally-stored owner secret, re-acquires the pet by scanning this at the clinic.
- One-time, and consumed by the GET itself: unlike every other resolve route in this catalogue, a single `GET /e/{token}` both resolves AND atomically consumes the token, since the phone only ever reads here and there is no separate `/complete` step.
  A concurrent or repeat scan of the same QR always loses the race.
- Error states: `404` if the token is unknown or malformed; `410` if it was already used, naturally expired, the tag was revoked at the clinic, or the tag's root was superseded (replaced) since the session was created - `root` is fixed at the moment staff started the session, never re-read live, so a mid-session reissue surfaces as `superseded` rather than silently serving different data than what the vet saw on screen.
  All three `410` reasons collapse to the same "get a new code from the clinic" copy on the phone, and there is no retry endpoint: the app MUST NOT attempt to re-resolve the same token after any refusal.
- Fixed TTL: 600 seconds from creation, not extended by scanning or resolving, unlike the mint QR's TTL-extension-on-first-resolve.
- Full disclosure by default: this ceremony discloses the pet's complete opened profile-tree leaf set (plus the 3 reserved owner-control leaf hashes) unless staff picked a mask when creating the session.
  See "Masked export" below.
- On a successful scan, the app shows a confirm screen (clinic name, pet name) before it does anything with the data.
  Only after the owner confirms does it rebuild the profile tree, recompute `root` from the disclosed leaves, and cross-check that against the LIVE on-chain `profileRoot` for this pet's `dogTagIdField` before writing anything to local storage - the app trusts nothing it receives from this endpoint until that on-chain check passes.
- The app calls `GET /e/{token}` against the exact host parsed from the QR, never a host it already has stored or discovered for a clinic of the same name ("scanned host only" - the same rule every vet-facing ceremony in this catalogue follows).

### Masked export

Staff may withhold a subset of attribute leaves before generating the export QR.
When they do, the payload is a `RedactedTagArtifact` (`specs/leaf-commitment.md` section 15): every leaf staff left disclosed keeps its full opening, and every leaf staff masked is named only by its hash.
An export with no mask chosen is this format's degenerate case: nothing withheld, every attribute leaf disclosed, the same shape this ceremony always served before masking existed.
The QR shape, token grammar, one-time semantics, and TTL above are all unchanged by masking.
The scanning app still recomputes and independently verifies (`verifyRedactedArtifact`) before trusting or storing anything, exactly as it would for a fully-disclosed export.

### `artifactType`: tag or record (WP4.14)

The same `/e` QR ceremony, the same token grammar, and the same one-time/TTL semantics above also deliver a pet's issued RECORDS (vaccination records and future record types - `specs/leaf-commitment.md` section 16), reusing the ceremony rather than adding a new route (Kenneth round 2 item 9, confirmed round 2: "same QR").
`ArtifactExportResponse` (`specs/vet-public-api.yaml`) gains an `artifactType` field, `"tag"` or `"record"`, naming which of the two sibling wire shapes the rest of the payload is:

- `artifactType: "tag"` (or the field absent entirely, for a response predating WP4.14) - everything "Masked export" above already describes: a `RedactedTagArtifact`, `reservedLeafHashes` always exactly 3, verified with `verifyRedactedArtifact`.
- `artifactType: "record"` - a `RecordArtifact` (`specs/leaf-commitment.md` section 16, `specs/schemas/dogtag.record-artifact.v1.schema.json`): `reservedLeafHashes` always empty, the seven non-maskable leaves (`credentialSubject.dogTagId`, `recordType`, `credentialSchema.id`/`credentialSchema.version`, `issuer.chainId`/`issuer.contract`/`issuer.operator`) always present in `disclosed`, and an accompanying UNCOMMITTED block (`conformsTo`/`anchoring`/`presentation`) carried beside the artifact, never hashed. Verified with `verifyRecordArtifact`, never `verifyRedactedArtifact` - the two verifiers are not interchangeable (different reserved-count rule, different non-maskable set, no 64-leaf cap on the record side).

### Record share steps

Staff pick which of a pet's ISSUED RECORDS to share (a pet may have many, one per issuance - WP4.14 plan section 4, unlike a tag artifact's single active-per-pet model) before generating the export QR, then optionally mask a subset of that record's MASKABLE leaves (never one of the seven non-maskable ones - the vet portal's own mask picker refuses that choice before a session is ever created, and `verifyRecordArtifact` refuses it again on the wire regardless).
Everything else about the ceremony is identical to a tag export: `GET /e/{token}` resolves and atomically consumes the token in one call, the response's `root` is fixed at session-creation time, and the same `404`/`410` error states apply.

On a successful scan, the app shows a confirm screen (clinic name, record type, e.g. "Vaccination record") before doing anything with the data.
Only after the owner confirms does it rebuild the record's leaf set, recompute `root` from the disclosed leaves via `verifyRecordArtifact`, and independently cross-check the on-chain binding rules `specs/leaf-commitment.md` section 16 states (`rootIssuer[root] == issuer.contract`, `recordTypeOf(root) == keccak256(recordType)`, `isValid(root)`, `issuedBy(root) == issuer.operator`, `issuer.chainId` equals the chain the app is actually connected to) before writing anything to local storage - there is no `profileRoot(dogTagId) == root` check for a record the way there is for a tag, since the chain stores no record-to-dog association at all (the `credentialSubject.dogTagId` leaf is the record's only binding to a dog, and that binding is exactly what a non-maskable, hash-checked leaf inside an already-verified `root` gives a reader - never an independent on-chain lookup).
The `conformsTo`/`anchoring`/`presentation` block, when present, is stored and displayed alongside the verified artifact but plays no role in whether the record is trusted.
Unchanged by `artifactType` either way: the token grammar, one-time consumption, and TTL rules below apply identically to a tag share and a record share.

### Parsing rules

1. The scheme MUST be `https`.
2. The path MUST match `^/e/[0-9a-f]{32}$` exactly, with no trailing slash, query string, or fragment.

## Import QR (share to vet)

```
https://<vet>/i/<32hex>
```

- `<vet>` and `<32hex>` as above (same token grammar as mint and verify).
- Resolves via `GET /i/{token}` in `specs/vet-public-api.yaml`; submitted via `POST /i/{token}/complete`.
- Printed or displayed by vet staff to pull a pet's tag data FROM the owner's phone.
  Staff pick the target (an existing pet record, or "create new") before generating the code.
- Non-consuming resolve, consuming complete: `GET /i/{token}` only returns a confirmation screen's worth of context (clinic name, and staff's chosen target) and can be safely retried, mirroring `GET /w/{token}`'s shape.
  `POST /i/{token}/complete` is the action that consumes the token, on every outcome, success or refusal alike, mirroring `POST /w/{token}/complete`'s own "a burned token is simply dead" rule.
- Error states: `GET /i/{token}` refuses with `404` (unknown or malformed) or `410` (already used or expired) before the owner ever sees the confirmation screen.
  `POST /i/{token}/complete` additionally refuses with `400` (`malformed_claim`, `chain_unreadable`, or `root_unset` - no valid claim could be established at all) or `409` (`revoked`, `verify_failed`, or `already_has_active_tag` - a real claim was identified but its current state conflicts with completing the import), on top of the same `404`/`410` above.
  There is no retry for any `POST` outcome; a fresh attempt needs a fresh QR from the clinic.
- Fixed TTL: 600 seconds from creation, same as the export QR above, not extended by resolving.
- On a successful scan, the app shows a confirmation screen naming the clinic and staff's chosen target, then lets the owner pick which of THEIR OWN local pets to send.
  The vet-chosen target is display context only, never a restriction on which local pet's data the app will submit.
  The owner re-authenticates (biometric) before the app rebuilds and submits that pet's data.
- The app calls both `GET /i/{token}` and `POST /i/{token}/complete` against the exact host parsed from the QR ("scanned host only", as above) - never a different host, even across the two calls of the same ceremony.

### Parsing rules

1. The scheme MUST be `https`.
2. The path MUST match `^/i/[0-9a-f]{32}$` exactly, with no trailing slash, query string, or fragment.

## Records verify QR (WP4.14)

```
https://<vet>/v/<32hex>
```

- `<vet>` and `<32hex>` as above (same token grammar as mint, verify, wallet-registration, tag-export, and tag-import).
- Resolves via `GET /v/{token}` in `specs/vet-public-api.yaml`; submitted via `POST /v/{token}/complete`.
- Printed or displayed by any clinic staff member (not necessarily a vet) to ask an owner's phone to present ONE of that pet's issued records (a vaccination `RecordArtifact`, `specs/leaf-commitment.md` section 16, or a future record type) for independent on-chain verification - a visiting pet's rabies proof at a boarding facility or a new clinic, say.
- **Blind presentment**: unlike the export ceremony, staff do not pick a pet or a specific record before generating the code - the session names only which clinic is asking.
  The owner's device chooses which record, and optionally which of that record's own MASKABLE leaves, to disclose, exactly as if handing over a paper certificate: the clinic does not know in advance what will be shown.
  The seven non-maskable leaves (`specs/leaf-commitment.md` section 16) can never be withheld, the same rule the export ceremony's own mask picker already enforces.
- Non-consuming resolve, consuming complete, mirroring `GET /w/{token}` / `POST /w/{token}/complete`'s own shape (not `GET /e/{token}`'s one-shot pattern - unlike an export, this ceremony has something for the phone to submit back): `GET /v/{token}` returns clinic name and session status only, and can be safely retried.
  `POST /v/{token}/complete` is the action that consumes the token, on every outcome from that point on - a burned token is simply dead, and there is no retry endpoint for this ceremony.
  A request body that does not even parse as a `RecordArtifact` is the one narrow exception: it is refused BEFORE the token is looked up, so it does NOT consume the token, letting a confused or buggy client retry with a corrected body.
  Once a body parses as a shape-valid `RecordArtifact`, the token IS consumed even if verification then fails - a wrong-but-well-formed presentment counts as "presented," mirroring how a human ceremony works: you showed the clinic something, right or wrong.
- Error states: `GET /v/{token}` refuses with `404` (`not_found`: unknown or malformed) or `410` (`expired_or_reused`: naturally expired while still pending) before the owner ever sees a confirm screen.
  `POST /v/{token}/complete` additionally refuses with `400` (`malformed_artifact`: the request body does not parse as a `RecordArtifact` - does NOT consume the token, see above) on top of the same `404`/`410` above.
  A shape-valid artifact that then fails verification is NOT an error response: it returns `200` with a `result` object naming the failure stage (see "Verification result" below) - the ceremony's job is to report what it found, not to treat a genuine forgery or a stale anchor as a transport-level failure.
- Fixed TTL: 600 seconds from creation, same as the wallet-registration/export/import ceremonies above, not extended by resolving.
- On a successful scan, the app shows a confirm screen (clinic name) then lets the owner pick ONE issued record and, optionally, a mask over that record's own maskable leaves, before biometric-gating and posting the resulting `RecordArtifact` body.
- The app calls both `GET /v/{token}` and `POST /v/{token}/complete` against the exact host parsed from the QR ("scanned host only", the same rule every vet-facing ceremony in this catalogue follows).
- `/v/<token>` and the pre-existing `/v1/...` versioned API namespace (`specs/vet-public-api.yaml`'s booking/payments/entity/consent routes) are unrelated and cannot collide: `v` here stands for "verify" (this ceremony's own single-letter mnemonic, alongside `/p`/`/w`/`/e`/`/i`/`/x`), not a version number, and no URL path segment is ever literally `v1` for this ceremony's own routes.

### Verification result

`POST /v/{token}/complete`'s response (`RecordVerifyCompleteResponse`, `specs/vet-public-api.yaml`) carries a `result` object with a `stage` field, run through the exact five-check on-chain binding rule `specs/leaf-commitment.md` section 16 specifies for any third-party record verifier - applied by the CLINIC'S OWN backend on the phone's behalf, against its own configured chain/factory, never trusting the artifact's own claimed issuer without cross-checking it (the phone needs no RPC access of its own for this ceremony, unlike the export ceremony's app-side cross-check):

- `"crypto_failed"` - the presented artifact fails structural/cryptographic self-verification (`verifyRecordArtifact`) before any chain read is even attempted. This covers: the Merkle root not recomputing from the disclosed leaves; ANY of the seven non-maskable keyPaths (`credentialSubject.dogTagId`, `recordType`, `credentialSchema.id`, `credentialSchema.version`, `issuer.chainId`, `issuer.contract`, `issuer.operator`) masked or missing from `disclosed`; a disclosed `credentialSchema.id` leaf disagreeing with the artifact's own top-level `schemaId`, when present; or the leaf set otherwise being malformed (an owner-control keyPath spoofed, a keyPath disclosed twice, or a keyPath named in both `disclosed` and `obfuscatedLeafHashes`).
  Because all seven non-maskable leaves are already guaranteed present by this same self-verification, the four leaves the next stages read (`issuer.contract`, `issuer.operator`, `issuer.chainId`, `recordType`) are a verified subset of them, not a separate, narrower requirement.
- `"wrong_chain"` - the artifact's own `issuer.chainId` leaf does not match the chain the verifying clinic is actually connected to. Checked before any chain read is attempted.
- `"chain_unreadable"` - a chain read failed or could not be attempted at all (RPC error, timeout, or the clinic's own on-chain factory address is not configured); never conflated with a genuine on-chain absence.
- `"not_anchored"` - the artifact's crypto and chain are both readable, but they disagree, with a `reason`: `"root_unset"` (this root was never issued by anyone), `"issuer_mismatch"` (the root resolves on-chain to a DIFFERENT clone than the artifact's own `issuer.contract` claims - anti-substitution), `"record_type_mismatch"` (the resolved clone's `recordTypeOf` disagrees with the artifact's own claimed `recordType`), or `"operator_mismatch"` (the resolved clone's `issuedBy` disagrees with the artifact's own claimed `issuer.operator`).
- `"verified"` - every crypto and chain check agrees; a `validity` field further splits this into `"valid"`, `"expired"` (past the `validUntil` leaf's UTC end-of-day cutoff, `specs/leaf-commitment.md` section 16), or `"revoked"` (the resolved clone's `isValid(root)` is false - the only way this differs from a false-because-never-issued case, since `not_anchored/root_unset` already covers that one).

The stored/returned result also carries `disclosedKeyPaths` (which fields the presented artifact actually disclosed, for display) but never the leaf VALUES themselves - this endpoint is unauthenticated, and the session it writes to is later polled by clinic staff over a separate, deployment-internal API out of scope for this spec.

### Parsing rules

1. The scheme MUST be `https`.
2. The path MUST match `^/v/[0-9a-f]{32}$` exactly, with no trailing slash, query string, or fragment.

## Payment QR (EIP-681)

Two shapes, depending on whether the expected payment is the chain's native asset or an ERC-20 token.

### Native asset transfer

```
ethereum:<addr>@<chainId>?value=<wei>
```

- `<addr>` is the vet's receiving address, `0x`-prefixed 40 hex.
- `<chainId>` is the numeric chain id (e.g. `1` for Ethereum mainnet, `8453` for Base, `84532` for Base Sepolia).
- `<wei>` is the exact expected amount in wei, decimal, no separators.
  The vet platform assigns a unique expected amount per payment (sub-cent dust disambiguation) precisely so this value alone identifies which invoice a matching on-chain transfer belongs to.

### ERC-20 token transfer

```
ethereum:<token>@<chainId>/transfer?address=<to>&uint256=<amount>
```

- `<token>` is the ERC-20 contract address (USDC or USDT on the given chain), `0x`-prefixed 40 hex.
- `<chainId>` as above.
- `/transfer` names the ABI function this payment calls, per EIP-681.
- `address=<to>` is the vet's receiving address, same shape as `<addr>` above.
- `uint256=<amount>` is the exact expected amount in the token's smallest unit (e.g. 6 decimals for USDC/USDT), decimal, no separators.

### Parsing rules

1. The scheme MUST be `ethereum`, not `https`; a general-purpose QR scanner without wallet integration will typically offer to open this in whatever wallet app is registered for the scheme, which is the intended fallback.
2. `<chainId>` MUST be validated against the set of chains the vet platform actually watches for that payment (mainnet or the matching Sepolia testnet, per the payment's own `chain` field from `specs/vet-public-api.yaml`'s `PaymentPublicStatusResponse`) before a wallet is asked to send funds; a chain id mismatch between the QR and the invoice record is a hard reject, never a warning.
3. The amount parameter (`value` or `uint256`) MUST be parsed as an unsigned decimal integer string, never as a native floating-point number, for the same bit-exactness reason every other protocol amount is string-encoded.

## Receipt URL

```
https://<vet>/r/pay/<receiptToken>
```

- `<vet>` as above.
- `<receiptToken>` is a standalone bearer token scoped to one paid invoice, at least 128 bits of entropy, distinct in purpose from the mint/verify token grammar above (it is not burned on first use, so the same receipt QR keeps working for re-downloads).
- Resolves via `GET /r/pay/{receiptToken}` in `specs/vet-public-api.yaml`, returning the receipt PDF directly.
- Printed on the invoice itself once a payment is confirmed `paid`; scanning it before that point returns 404, since there is no receipt to serve yet.

### Parsing rules

1. The scheme MUST be `https`.
2. The path MUST match `^/r/pay/.+$`; unlike the mint and verify tokens, the receipt token's exact length and alphabet are an implementation choice of the issuing vet platform (it never crosses into the Merkle tree or any cryptographic construction), so a parser matches the path shape only and defers character-set validation to the server response.
