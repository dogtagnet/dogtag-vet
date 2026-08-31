# DogTag QR payload formats

This document lists every QR payload in the DogTag ecosystem, its exact grammar, and how a scanner must parse it.
Every payload is a plain URL or URI a general-purpose camera app already knows how to open, so a device without the DogTag app installed still lands somewhere sensible (an app-install page, or in the payment cases, the user's own wallet app).

## The token grammar

This section covers the mint and verify session tokens only.
The receipt token has its own, deliberately different grammar; see "Receipt URL" below.

Every mint or verify session token in this ecosystem is 32 lowercase hexadecimal characters: `^[0-9a-f]{32}$`.
That is 128 bits of entropy, base16-encoded, always lowercase on the wire.
A parser MUST reject a mint or verify token that is the wrong length, contains uppercase hex digits, or contains any character outside `[0-9a-f]`, rather than attempting to normalize it.
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
3. A scanner that recognizes the host as a known DogTag deployment (or recognizes the `/p/` shape generically) should open the app directly; otherwise it should fall through to a normal browser open, which the vet platform's own web page for that path handles by prompting an app install.

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

- `<vet>` is the vet platform's own host, same as the Mint QR above.
- `<32hex>` is the wallet-registration session token, matching the token grammar above.
- Resolves via `GET /w/{token}` in `specs/vet-public-api.yaml`.
- Printed or displayed by vet staff from a client's detail page ("Register wallet"); scanned by the owner's mobile app.
- Non-consuming: the same code can be rescanned until the owner posts `POST /w/{token}/complete`, which is the action that consumes the token.
  Unlike the Mint QR, a signature that fails to verify on `/complete` ALSO consumes the token - there is no retry endpoint for a wallet-registration session, so a garbled or wrong-signer submission against a real code permanently kills it and the vet must generate a fresh one.

### Parsing rules

1. The scheme MUST be `https`.
2. The path MUST match `^/w/[0-9a-f]{32}$` exactly, with no trailing slash, query string, or fragment.
3. A scanner that recognizes the host as a known DogTag deployment (or recognizes the `/w/` shape generically) should open the app directly; otherwise it should fall through to a normal browser open, which the vet platform's own web page for that path handles by prompting an app install.

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
