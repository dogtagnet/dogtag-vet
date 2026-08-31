# Mobile booking protocol v2

This document covers the mobile booking protocol added in WP4.4: the optional `mobile` block on `POST /v1/booking/book`, the signed wallet claim, the tag-claim reconciliation tiers, the provenance box on the appointment detail page, and the staff review flows those tiers produce.
The normative wire contract lives in `plans/wp4.4-mobile-booking-protocol.md` and `protocol/specs/vet-public-api.yaml`; this page explains the flow, the trust model, and what staff actually see and do.

## Purpose

Today's public booking form (`/book`, `POST /v1/booking/book` v1) takes a name/email/phone and books an appointment - fine for a first-time walk-up, but it has no way to say "this is the SAME client who already has a record here" or "this booking is for a pet that already has a DogTag."
The DogTag app can do better: it may already hold a wallet the owner has proven control of, and it may already hold a pet's tag claim (`dogTagIdDec`/`dogTagIdField`).
WP4.4 lets the app assert both, and defines exactly how much the server trusts each assertion - the wallet claim is cryptographically verified before anything else happens; the tag claim is chain-corroborated in tiers, from "just an assertion" up to "a holder of the real profile data proved it."

## The pre-existing bug this WP also fixes

`POST /v1/booking/book` returned only `{appointmentId, status, ics}` - the manage credential (`cancelToken`) went out ONLY in the confirmation email's link.
Both apps already read `response.token ?? appointmentId` and use THAT as the bearer credential for `GET/POST /v1/booking/appointments/{id}` and its `/cancel` companion - since the response never carried a `token`, every such call fell back to `appointmentId`, which those routes correctly reject (`token` missing or does not match `id`), so "My bookings" never worked on either platform.
`BookAppointmentResponse` now carries `token` directly.
No app-side change was needed for this half of the fix - both apps started working the moment the server returned it.

## The wire

`POST /v1/booking/book`'s request gains one optional block, backward compatible - an old client that never sends `mobile` at all keeps booking exactly as it did before this WP:

```json
{
  "serviceId": "svc-checkup",
  "startAt": "2026-09-01T10:00:00.000Z",
  "client": {"name": "Jordan Alvarez", "email": "jordan@example.com", "phone": "+1-555-0100"},
  "mobile": {
    "source": "dogtag_app",
    "wallet": {"address": "0x...", "signature": "0x... (65 bytes)", "issuedAt": 1735689600, "deadline": 1735690200},
    "pet": {"dogTagIdDec": "42", "dogTagIdField": "123...", "name": "Rex"}
  }
}
```

`wallet` and `pet` are both independently optional - a booking may carry neither (identical to v1), either alone, or both together.
Appointments booked through this block always write `source: "mobile"` (the enum value has existed since WP4 but was never written until now) and, when `mobile` is present, a `bookingIdentity` provenance subdoc - see "The provenance box" below.
`source` is also now a filter on the staff `/appointments` list.

## The signed wallet claim

An unsigned wallet claim would let anyone book as someone else's client record, so the wallet claim is a `MobileBooking` EIP-712 signature, reusing WP4.2's server-verification idiom exactly (`lib/registration/flow.ts`'s `completeRegistration`: the server rebuilds the entire domain and message from server-trusted values, and trusts nothing off the wire except the claimed `wallet` and the `signature` themselves).

**Domain**: `{name: "DogTagMobileBooking", version: "1", chainId: <ROAX chain id>, verifyingContract: <this clinic's own on-chain clone address>}`.
**Struct**: `MobileBooking { address clinic; bytes32 bookingHash; address wallet; uint64 issuedAt; uint64 deadline }`.
The production TypeScript copy lives in `src/lib/booking/mobileEip712.ts`; known-answer vectors are pinned in `protocol/specs/eip712-mobile-booking-vectors.json`.

`clinic` and `bookingHash` are never accepted from the wire - the server always derives both itself (`clinic` from `ClinicSettings.cloneAddress`; `bookingHash` below), so a request can never claim a domain or binding it did not actually sign over.
The wire's `mobile.wallet` block therefore carries only `address`, `signature`, `issuedAt`, and `deadline`.

### `bookingHash` - binding a signature to THIS booking

`bookingHash` binds the signature to this booking's exact content, so it cannot be replayed onto a different slot, a different service, a different claimed client, or a different tag claim.
It is `keccak256` of a **hash-of-hashes** over six fields, in this order: `serviceId`, `startAt` (unix seconds, decimal string), `client.name` (trimmed), `client.email` (trimmed, lowercased), `client.phone` (trimmed, or `""` if absent), `dogTagIdField` (the wire's own value, or `""` if this booking carries no tag claim).
Each field is hashed independently FIRST, and the six 32-byte digests (not the raw field bytes) are concatenated and hashed again - never a plain delimited string join, which is ambiguous whenever a free-text field (name, phone) can itself contain the delimiter or shift content across a field boundary.
The production implementation is `computeMobileBookingHash` in `src/lib/booking/bookingHash.ts`; known-answer vectors for cross-language parity are pinned in `protocol/specs/mobile-booking-hash-vectors.json`.
This is the one piece of WP4.4 that is genuinely normative for the app to reproduce byte-for-byte and is not itself EIP-712 - get it wrong and every signature recovers to the wrong digest, which the server sees as an invalid signature, never a silent partial success.

### Verification and rejection (Q2)

The server independently rebuilds the domain/message and recovers the signer via `recoverTypedDataAddress`.
**An invalid signature rejects the WHOLE booking**, with a specific error - never a booking that silently drops the wallet claim and proceeds anyway.
`error.code: wallet_claim_invalid` covers every verification failure, with `error.details.reason` naming which check failed:

| `reason` | Meaning |
| --- | --- |
| `signature_invalid` | The signature does not recover to the claimed `wallet` (wrong signer, malformed signature, or a `bookingHash`/`clinic` mismatch from signing over different booking content). |
| `expired` | The server's current time is past `deadline`. |
| `window_too_long` | `deadline - issuedAt` exceeds the server-enforced max of 600 seconds (10 minutes) - enforced server-side, not merely a convention the app is trusted to follow. |
| `issued_in_future` | `issuedAt` is further ahead of the server's clock than a small clock-skew allowance - closes the gap a bare `deadline - issuedAt <= 600` check alone would miss (an `issuedAt` set a year out, with a short window immediately after it, would otherwise still pass). |
| `deadline_before_issued_at` | `deadline` is not strictly after `issuedAt`. |

If the clinic has not yet discovered its own on-chain clone (`ClinicSettings.cloneAddress` unset), there is nothing to verify a wallet claim against at all - a booking that carries one gets `503 clinic_not_configured` instead.

**Replay protection**: the server dedupes on `bookingHash` - a signed claim that already produced an appointment is rejected outright (`error.code: wallet_claim_replayed`) on a second attempt, whether that is a genuine replay or an accidental client retry with identical content.
A partial unique index on `Appointment.bookingIdentity.bookingHash` backstops the (deliberately checked-first, for a clean error message) application-level pre-check against a genuine race between two concurrent replays of the identical claim.
Replay protection is scoped to non-terminal appointments: cancelling (or marking no-show) moves the hash aside to `bookingIdentity.releasedBookingHash` - kept for audit, never deleted - so the exact same signed configuration can be legitimately re-booked after a cancellation, while replays against a still-active appointment keep rejecting.
Because the pre-check and the partial unique index both match on the live `bookingIdentity.bookingHash` field itself, the two enforcement layers agree with this scoping by construction.

## Client resolution (Q1)

Returning-user resolution tries, in order: a verified wallet match against `Client.wallets[]` (active entries only - a revoked wallet's key may have been revoked BECAUSE it was compromised, so a signature from it must not still resolve to the client that once owned it); else today's email-then-phone match; else create.
The same wallet may legitimately sit on more than one client record (WP4.2 allows it - e.g. a household); in that case resolution is deterministic - the client whose active registration of this wallet is EARLIEST wins, ties broken by clientId - and the ambiguity is persisted as `bookingIdentity.walletMultiMatch` and surfaced in the provenance box, never silently picked over.
Existing client fields are never overwritten by a booking, same doctrine as v1.

**Auto-attach**: both attach paths - the WP4.2 QR ceremony and a mobile booking's signed claim - are wallet-signed, so both are legitimate.
A valid booking signature auto-attaches the wallet to whichever client the booking resolved to (unless it is already on that client's `wallets[]`), flagged `via: "booking"` so it is visibly distinct from a QR-ceremony registration (`via: "registration"`, or unset on data that predates this field) wherever wallets are displayed - see "The Wallets panel" below.

## Tag claim resolution tiers

The tag claim (`mobile.pet`) is asserted, not itself signed - anyone who knows a `dogTagIdDec` can claim it (it is meant to be read off a physical tag).
Trust in it comes entirely from what the SERVER independently corroborates, in tiers:

1. **LOCAL** - an indexed lookup on `Pet.dogTag.dogTagIdDec`/`dogTagIdField` finds a pet on file at this clinic already.
   If the resolved client is genuinely among that pet's owners, the appointment links straight to it (`tagResolution: "local"`).
   If NOT - someone else's tag claimed by a booking that doesn't check out as belonging to them - the pet is **deliberately not linked**.
   This is the hijack guard: silently linking would write an appointment `lib/booking/appointmentTagging.ts`'s own ownership invariant (`docs/appointments.md`) says every OTHER write path enforces, and that no staff Edit-tagging save could ever pass again.
   Instead the claim is flagged `needsReview: true` with `candidatePetId` naming the pet the claim pointed at, for staff to resolve by hand.
2. **NOT local, zero root** - no pet is on file, and `DogTagSBTConsent.profileRoot(dogTagIdField)` reads back all-zero (never issued anywhere, or an id staff mistyped).
   `tagResolution: "unknown"` - the booking is kept; only the tag claim is set aside.
3. **Root exists, issued by THIS clinic** - `VetIssuerFactory.rootIssuer(root)` names this clinic's own clone, but no local `Pet` record carries the link (typically after a database restore).
   `tagResolution: "issued_here_unlinked"` - a staff banner offers a one-click relink (see below).
4. **Root exists, issued by a DIFFERENT clinic** - `tagResolution: "external"`, `issuerClone` names the issuing clone, and `VetIssuer.isValid(root)` is read against THAT clone (never this clinic's own - `isValid` on our own clone cannot distinguish "foreign" from "revoked", which is exactly why `rootIssuer` is read first).
   A **provisional pet record** is imported ONLY when Q3's full gate passes - see "External tag import" below; otherwise the booking is appointment-only, and a pet record gets created at arrival as usual.
5. **No tag claim at all** - `tagResolution: "none"`.

Every chain read above is fail-closed by construction (`lib/chainRead.ts`'s own contract) but **never lets a chain hiccup lose the booking**: an unreadable RPC folds to `tagResolution: "unknown"` with `verificationError: true` (distinct from a genuinely-zero root, `verificationError: false`, even though both share the one locked wire value) - only Q2's signature check, pure local computation with no I/O, can reject the whole booking.

### External tag import (Q3)

A provisional pet record is created ONLY when BOTH hold:

1. The tag verifies on chain as tier 4 describes (issuer identified, `isValid` true).
2. The booking carries VERIFIABLE raw pet data - the app's opened profile-tree leaves (`keyPath`, `salt`, `value`, `tag` - the pet's FULL disclosure, not a selective subset) plus the 3 reserved owner-control leaf hashes, and the server recomputes the Merkle root with the exact same `verifyLeafCommitment` machinery the custodial-bind flow uses (`@dogtag/standard`, never reimplemented).
   The recomputed root MUST equal the on-chain `profileRoot` read in tier 4 - a claimed root is never trusted, only ever recomputed and compared.

`verifyLeafCommitment`'s `expectedIdentityLeaves` check is a deliberate no-op on this path: it is checked against ITSELF (the `owner.identity.*` subset of the very leaves being verified), because there is no vet-attested expected set for a tag this clinic never issued.
Every OTHER check the function performs still applies in full - the reserved-leaf count, the leaf cap, no reserved-keyPath spoofing, no duplicate keyPaths, and, the one that actually matters here, the full Merkle root recompute against the on-chain root.

If import succeeds, `credentialSubject.name`/`species`/`breedLabel` (or `breedVbo`)/`sex`/`dateOfBirth` are imported from the verified leaves into a new `Pet` record - or an EXISTING one, if this exact `dogTagIdField` was already imported on a previous visit - marked `dogTag: {dogTagIdDec, dogTagIdField, root, cloneAddress: <issuer>, status: "active", external: true}` and linked to the resolved client.
`external: true` excludes the record from this clinic's own tags/issuance surfaces (`/tags`, `/tags/issue`) - this clinic never issued it and has no lifecycle authority (revoke/reactivate/replace) over it - but it is a normal pet record everywhere else (appointment tagging, the pet detail page, which shows an "External" badge instead of the usual "Manage in Tags" link).

If no verification data is sent, or verification fails, the booking is appointment-only: `tagResolution` and the rest of `bookingIdentity` still record what WAS resolved (external, issuer known, valid or not), but no pet record is touched by the booking itself - one gets created by staff at arrival, same as any other new pet.

### Assurance levels (Q4)

| Level | What it proves | Where it applies |
| --- | --- | --- |
| 1 - asserted + chain-corroborated | The tag exists, is active, and its issuer is known - ownership is NOT proven. | Appointment annotation (tiers 1-4 above) - guarded by tier 1's review flag against a bare-assertion hijack. |
| 2 - data-verified | A holder of the REAL profile data produced it (leaves recompute to the on-chain root). | Pet-record import (Q3) - the gate described above. |
| 3 - ownership-proven (consent-ZKP) | The verify flow's own mechanism - cryptographic proof of present ownership, not just possession of the opened data. | Queued as a later upgrade for booking; not implemented by this WP. |

Staff never has to work this out by eye - the provenance box labels each claim with its resolved tier and, implicitly, its level.

## The provenance box

Every `source: "mobile"` appointment's detail page shows a provenance box built from `bookingIdentity`: the wallet address (with a verified/unverified badge) and the tag claim's resolved tier, rendered the same way every other on-chain fact in this app is (`AddressChip`/`HashCell`, mono, middle-truncated, an explorer link for the issuer clone whenever one is known - the guaranteed floor even when a friendly issuer name cannot be resolved).

- **`local`, no review needed**: a plain link to the linked pet.
- **`local`, `needsReview: true`**: a warning banner naming `candidatePetId` - "this claim named a pet you're not one of the registered owners of; review before treating this booking as related to it."
- **`issued_here_unlinked`**: a banner explaining the tag was issued by this clinic but isn't linked to a pet record locally (most often, a database restore lost the link), with a "Relink" action - staff pick the pet this belongs to, the server re-verifies (`profileRoot`/`rootIssuer`) before writing, and it uses the exact same `linkPetDogTag` write path the mint-confirm flow uses.
- **`external`**: the issuer clone (address + explorer link) and whether the tag is currently valid; when Q3's import succeeded, a link to the (possibly reused) imported pet record; when it did not, a note that the booking is appointment-only and a pet record can be created at arrival.
  The appointment-only note distinguishes three cases truthfully: no data was sent at all; data was sent but the issuer read back invalid, so the data was NOT evaluated (`verifyLeafCommitment` only runs against a valid issuer - the issuer is the failure, never the data); or the data itself genuinely failed the on-chain recompute.
- **`unknown`**: "no such tag" when the root was genuinely never issued, or "couldn't verify - try again" when a chain read failed transiently (`verificationError`) - staff sees which one it was, since they call for different next steps.
- **`none`**: no tag claim was made; the box shows only the wallet portion (or nothing, if neither was present).

## The Wallets panel

A client's Wallets panel (the client detail page) shows every wallet regardless of how it was attached, but a booking-sourced row (`via: "booking"`) is visually distinct and its expanded receipt shows the `MobileBooking` struct's own fields (clinic, `bookingHash`, wallet, `issuedAt`, `deadline`, signature, the appointment that attached it) rather than the `ClientRegistration` receipt's fields - the two are genuinely different signed payloads, and a booking-sourced row has no `registrationId`/`blockNumber` to show (the `MobileBooking` struct carries neither).
There is no "Download JSON" / offline-verify button on a booking-sourced row yet - `scripts/verify-receipt.ts` and its export contract stay scoped to `ClientRegistration` for now; the receipt itself is still fully persisted (`payloadJson`/`signature`/`recoveredAt`/`receiptHash`, computed with the exact same generic hashing `lib/registration/receipt.ts` already provides), just without that one offline-tooling surface.

## Public API protection

`POST /v1/booking/book` goes through the same protection triple every public route in this app uses: a per-route, per-client-IP rate limit, a request body size cap, and a best-effort abuse log entry on a rejection (`src/lib/publicApi.ts`, `src/lib/rateLimit.ts`, `src/lib/abuseLog.ts`).
See `docs/DEPLOY.md`'s "Protecting your deployment" section for how this composes with a Cloudflare (or other reverse-proxy) front end for a self-hosted deployment - the mobile booking surface is exactly the kind of open-by-design, publicly-known endpoint that section is about.
