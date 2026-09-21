# Release notes

## 1.3.0 release (WP4.17)

This entry tracks the cross-repo 1.3.0 product release.
The version number itself lives on the iOS app, in `dogtag-ios`'s `project.yml`; this repo is not independently versioned.

### Hand-authored cross-repo vector files

Four EIP-712 and booking-hash known-answer vector files in this repo were hand-authored.
They were generated once by a standalone script against this repo's own installed `viem`, not derived from `dogtag-protocol`, and have no counterpart anywhere in `dogtag-protocol`'s own history.
See `tests/unit/vectors/README.md` for the full story of why they live outside `protocol/`.
They are also copied byte-for-byte into `dogtag-ios` (`DogTagTests/Fixtures/`), which carries two further delegation-claim vector files of the same kind that never lived here.

- `tests/unit/vectors/eip712-client-registration-vectors.json`
- `tests/unit/vectors/eip712-client-registration-signature-vectors.json`
- `tests/unit/vectors/eip712-mobile-booking-vectors.json`
- `tests/unit/vectors/mobile-booking-hash-vectors.json`

Their protocol ownership is pending Kenneth's decision on whether to promote them to genuine `dogtag-protocol` spec artifacts under `specs/vectors/` (open question 7, `plans/wp4.17-release-and-workstation.md` section 5).
Until then, this directory is their canonical home for this repo.
