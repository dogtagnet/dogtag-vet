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
