# Client wallet registration

This document covers the client-side wallet registration flow added in WP4.2.
The normative wire contract lives in `plans/wp4.2-client-wallet-registration.md` and `protocol/specs/vet-public-api.yaml`; this page explains the flow, the trust model, and how to verify a receipt offline.

## Purpose

A vet registers a client's wallet address for bookkeeping.
Multiple wallets can be registered per client, each with its own independent receipt.
Staff can revoke a wallet later, but revocation is a bookkeeping flag only - the receipt itself is never deleted.

There are no on-chain writes anywhere in this flow, now or automatically in the future.
Receipts are canonically encoded and hashed so they *could* be anchored on chain later (see "Chain-ready" below), but nothing anchors them today.

## The flow

1. Staff opens a client's detail page and clicks "Register wallet".
   The server creates a one-time session: it stamps the current time (`issuedAt`), reads the current ROAX block number (`blockNumber`), computes an opaque `clientHash` commitment from the client's stored contact fields, and mints a 32-hex one-time token good for 600 seconds.
2. The staff page shows a QR code encoding `https://<vet>/w/<token>`, plus a visible fallback link and a live countdown.
3. The owner scans the code with the DogTag app, which calls `GET /w/{token}` to fetch the challenge.
   The response carries the clinic's display name, the client's *masked* name, the opaque `clientHash`, and the raw struct fields the app will sign - never the client's raw name, email, phone, or address.
4. The app shows a consent screen: the clinic name, the masked client name, the wallet address about to be registered, and the `issuedAt`/`blockNumber` as informational detail.
   The owner reviews this and confirms.
5. The app builds the `ClientRegistration` EIP-712 message (see below), signs it with the wallet's own key, and posts `{wallet, signature}` to `POST /w/{token}/complete`.
6. The server independently rebuilds the exact same EIP-712 domain and message from its own server-trusted session state (never trusting the request body for anything except the claimed `wallet`, which is itself part of the signed struct) and recovers the signer.
   If the recovered signer equals the claimed wallet, the token deadline has not passed, and this wallet is not already registered to this client, the receipt is appended to `Client.wallets[]` and the flow succeeds.
7. The staff page, which has been polling a status endpoint the whole time, shows "Wallet 0x... registered" and the wallet appears in the list.

## The signed message

The full struct definition is normative in `plans/wp4.2-client-wallet-registration.md`; the production TypeScript copy lives in `src/lib/registration/eip712.ts`.
At a glance, the EIP-712 domain is `{name: "DogTagClientRegistration", version: "1", chainId: <ROAX chain id>, verifyingContract: <this clinic's clone address>}`, and the `ClientRegistration` struct carries `clinic`, `clientHash`, `registrationId`, `wallet`, `issuedAt`, `blockNumber`, and `deadline`.

Every field except `wallet` is chosen and snapshotted entirely by the server at session-creation time; the owner's device only ever fills in `wallet` (which it then signs over) and never negotiates any other field.

## Trust model

This is the part worth reading carefully before treating a receipt as proof of anything more than what it actually proves.

- **The server computes `clientHash`, and only the server ever sees the inputs that produced it.**
  `clientHash = keccak256(utf8(canonicalJson) || uuidBytes16)`, where `canonicalJson` is the client's stored `address`/`email`/`name`/`phone` fields (sorted keys, trimmed values, missing optional fields as empty string).
  The owner's device receives this hash as an opaque 32-byte value and signs over it without ever being able to open it back up into the underlying fields.
- **The owner sees, and vouches for, exactly two things: the clinic's display name and their own masked name.**
  The masked name is "first letter per word, asterisks for the rest" (e.g. `Jordan Alvarez` becomes `J***** A******`) - just enough for the owner to recognize themself, never enough to leak the full name to anyone who intercepts the challenge response.
- **A signed receipt therefore proves this, and only this**: "the holder of this wallet's private key, having seen the clinic name and their own masked name, agreed to bind this wallet to *whatever client record* hashes to `clientHash` under this exact `registrationId`."
  It does **not** prove that the underlying PII (the raw name, email, phone, or address the vet has on file) is accurate, current, or even real - the owner never saw it and could not have checked it.
  If the vet's records are wrong, the receipt is still a valid receipt; it just binds the wallet to the wrong (or stale) commitment.
- **Signature verification proves possession of the wallet's key at signing time, not present-day control of the funds or account.**
  As with any off-chain signature, a compromised or since-transferred key does not retroactively invalidate a receipt that was valid when it was signed.

## Token lifecycle

- One-time, 600-second TTL, 32 lowercase hex characters - the same grammar as the mint and verify session tokens (`protocol/specs/qr-formats.md`).
- Consumption is atomic (`findOneAndUpdate({token, consumed: false}, ...)`), so a race between two concurrent completion attempts can only ever let one through.
- **Unlike the mint flow, there is no retry endpoint.**
  A signature that fails to recover to the claimed wallet still permanently consumes the token - the fail code is `signature_invalid`, but the token is gone all the same.
  This means a garbled submission, a bug in a third-party wallet's signing implementation, or someone scanning the code with the wrong account all have the same consequence: the QR code is dead, and staff must generate a fresh one.
  The Wallets panel's UI reflects this directly - a failed attempt is shown as "Signature didn't match" with a "Generate a new code" action, never as if the same code might still resolve.
- The staff-facing status poll keeps answering `registered` (or `failed`, for a burned-by-bad-signature token) for one hour after consumption, then reports the session as simply gone.
  The owner-facing challenge endpoint (`GET /w/{token}`) has no such grace window - it 410s the instant the token is consumed, since the device already knows its own outcome from the `/complete` response.

## The receipt

Every registered wallet carries a receipt, persisted alongside it on `Client.wallets[]`:

```json
{
  "address": "0x...",
  "label": "Optional staff-assigned label",
  "registrationId": "8fd81415-a95c-9b04-c6f9-08ec7d0bcf3a",
  "receipt": {
    "payloadJson": "{\"domain\":{...},\"message\":{...}}",
    "signature": "0x... (65 bytes)",
    "recoveredAt": 1735689601
  },
  "receiptHash": "0x...",
  "issuedAt": 1735689600,
  "blockNumber": 42,
  "registeredAt": 1735689601,
  "revokedAt": null
}
```

`receipt.payloadJson` is a deterministic, fixed-key-order JSON encoding of exactly the `{domain, message}` pair that was signed - the same shape as one entry in `protocol/specs/eip712-client-registration-vectors.json`, minus the `expected` block.
`receiptHash` is `keccak256` of a deterministic encoding of `{payloadJson, recoveredAt, signature}` - the chain-ready anchor point mentioned in "Purpose" above.

This whole structure is designed to be re-verifiable **offline, forever**: nothing about verifying it requires this vet's database, this vet's server being online, or even this vet still existing.

## Verifying a receipt

The "Download" button on the Wallets panel saves exactly the JSON shape above to a file.
To independently re-verify it:

```bash
pnpm verify-receipt path/to/receipt.json
```

The script (`scripts/verify-receipt.ts`) does two things, both entirely offline:

1. Parses `receipt.payloadJson`, rebuilds the exact EIP-712 domain/message it encodes, and independently recovers the signer from `receipt.signature` - reporting whether that recovered address matches both the receipt's own `address` field and the signed message's own `wallet` field.
2. Independently recomputes `receiptHash` from the receipt's own `payloadJson`/`signature`/`recoveredAt` and reports whether it matches the stored value.

It exits `0` and prints `VALID` only if both checks pass, and exits `1` with a clear reason on any parse failure, signature mismatch, or hash mismatch - so it is safe to use in a script or CI check, not just interactively.

## Chain-ready, not chain-anchored

Every receipt is built so that anchoring it later - publishing `receiptHash` (or the full receipt) to a contract - would be a pure addition, not a redesign: the hash is already deterministic, the payload is already canonical, and nothing about today's flow needs to change to support it.
That work is explicitly out of scope for this WP; today, "chain-ready" means exactly what it says and no more.

## Revocation

`POST /api/clients/:id/wallets/:address/revoke` sets `revokedAt` on the matching wallet entry.
It is idempotent - revoking an already-revoked wallet leaves the original `revokedAt` timestamp untouched rather than re-stamping it.
The receipt is never deleted, so a revoked wallet's registration can still be independently re-verified after revocation; revocation only changes how the vet's own bookkeeping treats it going forward.

## Public API protection

`GET /w/{token}` and `POST /w/{token}/complete` both go through the same protection triple every public route in this app uses: a per-route, per-client-IP rate limit (30/min and 10/min respectively), a 16KB request body cap, and a best-effort abuse log entry on a rejection.
See `src/lib/publicApi.ts`, `src/lib/rateLimit.ts`, and `src/lib/abuseLog.ts` for the shared implementation, and `protocol/specs/vet-public-api.yaml` for the exact wire contract.
