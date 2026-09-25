# Release notes

## 1.4.1 release

Fixes a live workstation incident: an `issueTag` transaction (0xfb3414bac482635a0aa9c4a57e430ddf8a7ce6fb5cd5994564a45b38c5bfea47 on ROAX) failed with an OutOfGas revert because the wallet-submitted gas limit was exactly the bare, no-headroom `eth_estimateGas` result - the app's own gas-headroom helper (`legacyTxWithGas`) had silently fallen back to the wallet's own estimate.
Every ROAX write this app submits ends in a gas-refund transfer back to the operator, and `eth_estimateGas` systematically undercounts that transfer (it estimates at gas price 0, where the refund is zero and its transfer is skipped; the real send pays a real gas price and the transfer actually runs) - `legacyTxWithGas` now enforces a hard per-function gas floor underneath its existing estimate-based headroom, so a write can never go out under-provisioned again, whether or not a live estimate is available.
See `docs/DEPLOY.md`'s "Wallet gas for on-chain writes" section for the floor values and the MetaMask manual-gas-limit workaround for older images.

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

Their protocol ownership is repo-local by decision (Kenneth, 2026-09-21) - they stay here rather than being promoted to genuine `dogtag-protocol` spec artifacts under `specs/vectors/` (open question 7, `plans/wp4.17-release-and-workstation.md` section 5, now closed).
This directory is their canonical home for this repo.

## 1.4.0 release (WP4.18)

Booking payment rails become ROAX-only.
Ethereum, Base, Sepolia, and Base Sepolia leave the payment path entirely - their union members, Mongo enum values, token addresses, RPC env values, Settings receiving-address and RPC fields, and the CoinGecko price feed with its 10-minute cache are all removed, not merely hidden.
The payment chain registry keeps exactly one entry, `roax`, with two assets: PLASMA (native, 18 decimals) and RUSD, a development-only ERC-20 stablecoin deployed on ROAX (`contracts/src/dev/RUSD.sol` in `dogtag-protocol`; see `docs/DEV-TOKENS.md` there for what it is and is not).
Pricing is manual-rate only - there is no live price feed left to fall back to, and a crypto rail without a staff-entered rate cannot be created; RUSD's rate defaults to 1.00 in the invoice-creation form when the clinic's fiat currency is USD.
The payment watcher gains its own confirmation depth (`CONFIRMATIONS_ROAX`, default 2) and scan chunk size (`PAYMENT_ACTIVITY_CHUNK_BLOCKS_ROAX`, default 200), replacing the old mainnet/testnet-class confirmation split and the single ERC-20-sized chunk default.
An appointment's linked invoices are now visible from both the staff detail page and the phone's own `GET /v1/booking/appointments/{id}` response, and `GET /v1/payments/{id}/public` exposes each open rail's token amount, token symbol, chain id, receiving address, and EIP-681 payment request so the phone can pay without ever loading the staff-facing pages.

**Migration note**: an existing deployment must have no open (`pending`) crypto rails on any chain other than `roax` before upgrading to this release.
The four removed chains' Mongo enum values no longer exist, so a pending rail on one of them cannot be read back once this release is running - settle or cancel every such invoice first, on the pre-upgrade version.
A from-scratch workstation database is unaffected: it never had a non-ROAX rail to begin with.
