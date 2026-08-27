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

## Test commands

```
pnpm build        # production build
pnpm lint         # eslint
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest unit suite
pnpm test:e2e     # Playwright smoke (needs a running docker mongo)
pnpm worker       # the background worker process
```

## Protocol sync

`protocol/` is vendored, read-only.
It holds the contract ABIs, the wire-authoritative OpenAPI spec (`protocol/specs/vet-public-api.yaml`), the QR and issuer-attestation format specs, and the `@dogtag/standard` crypto library, wired in as a pnpm workspace package.
Re-vendor by re-copying that directory from the protocol repo; nothing in this app should ever need to change what lives inside it.

## Design decisions

### Invoice PDF library: pdfkit

wp4-vet.md asks for a choice between `pdfkit` and `@react-pdf/renderer`, justified here.

`pdfkit` was chosen because invoice generation in this app (`src/lib/payments/pdf.ts`) is a plain data-to-document transform - line items, totals, a QR image - with no need for a JSX component tree, CSS-like layout, or React's reconciliation model.
`pdfkit`'s imperative, stream-based API (`doc.text(...)`, `doc.image(...)`, `doc.moveDown()`) maps directly onto that kind of document and produces a `Buffer` with no intermediate render step, which fits both of this app's PDF call sites equally well: a route handler streaming a response, and a background email job attaching the same buffer.
`@react-pdf/renderer` is a better fit when a PDF's layout is itself complex and benefits from JSX composition and reuse across many document types; this app has exactly one document shape (the invoice/receipt), so that composability was not worth the extra dependency (a full React renderer distinct from the app's own React tree) or its own font-loading quirks under a bundled Node runtime.

`pdfkit` loads its font metrics from disk at runtime rather than at bundle time, so it is marked in `next.config.ts`'s `serverExternalPackages` (alongside the vendored crypto packages) rather than left for webpack to inline - inlining it would relocate that file lookup away from the package's real directory and break PDF generation at request time with the build still green.
`tests/unit/pdf.test.ts` guards against exactly that regression by asserting a real, non-trivial PDF buffer comes out, not just that the code compiles.

### Payment-view vs. receipt tokens

Every invoice carries two distinct bearer tokens, both unguessable and generated once at creation.

`Payment.viewToken` gates the public status page (`/pay/{id}?token=...`) and the wire-spec `GET /v1/payments/{id}/public` endpoint.
It works before and after payment, and is meant to be shared with the client alongside the invoice.

`Payment.receiptToken` gates the wire-spec `GET /r/pay/{receiptToken}` endpoint, which is printed as a QR code on the invoice PDF itself.
Per `specs/vet-public-api.yaml` and `specs/qr-formats.md`, that endpoint returns the receipt PDF directly and only once the payment is `paid` - scanning it before that returns a 404, by design, since there is no receipt yet to serve.
The public status page offers its own "download invoice" link (unstamped, working at any time) precisely so a client has something to download before that point.
