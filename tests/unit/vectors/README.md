# Hand-authored cross-repo known-answer vectors

The four JSON files in this directory are known-answer vector sets for EIP-712 structs and the
`bookingHash` algorithm this app implements:

- `eip712-client-registration-vectors.json` - the WP4.2 `ClientRegistration` EIP-712 struct.
- `eip712-client-registration-signature-vectors.json` - the WP4.5 track-3 signature vectors
  (wire-shaped challenge plus private key plus expected signature), a companion to the file above.
- `eip712-mobile-booking-vectors.json` - the WP4.4 `MobileBooking` EIP-712 struct.
- `mobile-booking-hash-vectors.json` - `computeMobileBookingHash` known-answer pairs.

Each was generated once by a standalone script against this repo's own installed `viem`, then
copied byte-for-byte into both `dogtag-vet` (here) and `dogtag-ios` (`DogTagTests/Fixtures/`), so a
hand-rolled Swift implementation can be vectored against the exact same values.

## These are NOT vendored from dogtag-protocol

They never existed anywhere in `dogtag-protocol`'s own history.
They used to live under `protocol/specs/`, which reads as vendored but is not: `scripts/sync-to.sh`
mirrors that whole directory with `rsync --delete`, so every real sync silently deleted all four,
worked around by a `git checkout --` restore immediately after (see the WP4.17A0 entry in
`plans/orchestration/wp4.17A0-progress.md` and the prior note this superseded in the top-level
`README.md`'s "Protocol sync" section).

WP4.17A0 moved them here, next to the tests that read them, specifically so a future
`scripts/sync-to.sh` run never touches or deletes them again.
If `dogtag-protocol` ever adopts these vectors as genuine protocol artifacts, move them back under
`specs/` there and re-point the imports below at the vendored copy; until then, this is their
canonical home for this repo, kept in sync with `dogtag-ios/DogTagTests/Fixtures/` by hand.

## Consumers

Seven test files import one of these four files directly (`./vectors/...` from files directly under
`tests/unit/`, `../vectors/...` from `tests/unit/registration/` and `tests/unit/booking/`):
`tests/unit/mobileBookingHash.vectors.test.ts`, `tests/unit/eip712ClientRegistration.vectors.test.ts`,
`tests/unit/eip712MobileBooking.vectors.test.ts`,
`tests/unit/eip712ClientRegistrationSignature.vectors.test.ts`, `tests/unit/registration/eip712.test.ts`,
`tests/unit/registration/uuid.test.ts`, `tests/unit/booking/mobileEip712.test.ts`.
`tests/unit/booking/bookingHash.test.ts` and `src/lib/booking/bookingHash.ts` reference
`mobile-booking-hash-vectors.json` in prose only, without importing it.
