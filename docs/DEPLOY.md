# Deploying dogtag-vet

This is a self-hosted app.
Each clinic clones this repository and runs its own copy - there is no shared or multi-tenant deployment of dogtag-vet.

## Quickstart (Docker Compose)

This is the fastest path to a running clinic instance, and the one this project is built around.

1. Clone the repository and enter it.
   ```
   git clone <this-repo-url> dogtag-vet
   cd dogtag-vet
   ```
2. Copy the environment template and fill in the values marked REQUIRED.
   ```
   cp .env.example .env
   ```
   At minimum, set:
   - `PUBLIC_BASE_URL` - the URL this instance will actually be reachable at (see "Getting a public URL" below if you do not have one yet).
   - `AUTH_SECRET` - generate one with `openssl rand -base64 32`.
   - `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`, or `EMAIL_SERVER` and `EMAIL_FROM` - at least one staff sign-in method.
   - `AUTH_TRUST_HOST=1` - required once this app sits behind a reverse proxy or tunnel (Cloudflare Tunnel, nginx) that terminates TLS and forwards the original host header, which every path this guide recommends does (see "Trusted proxy hops" below); Auth.js v5 refuses to serve `/api/auth/*` at all without it in that setup.
   - `VET_ISSUER_FACTORY_ADDRESS`, `ENTITY_REGISTRY_ADDRESS`, `DOGTAG_SBT_ADDRESS`, `VERIFICATION_REGISTRY_ADDRESS` - the protocol contract addresses on ROAX.
   - `DELEGATION_REGISTRY_ADDRESS` - the WP4.15 multi-owner DelegationRegistry contract address, required for the Owners card and the `/d/*` delegation routes.

   `.env.example` documents every other value and its default; leave the rest alone until you have a specific reason to change them.
3. Start the stack.
   ```
   docker compose up -d
   ```
   This builds the web image and the worker image, starts a Mongo container with a persistent volume, and starts both app processes.
4. Open `http://localhost:3000` (or wherever `PUBLIC_BASE_URL` points) and complete the setup wizard: sign in, connect a wallet, and let the wizard discover this clinic's clone.

That's it for a first run.
Everything else - receiving addresses for payments, the business profile card, chain RPC overrides - is configured from the running app's Settings page, not from environment variables, so it can change without a redeploy.

### Protocol addresses and RPC config are runtime values

`ROAX_RPC_URL`, `ROAX_CHAIN_ID`, `ROAX_EXPLORER_URL`, and the five protocol contract addresses (`VET_ISSUER_FACTORY_ADDRESS`, `ENTITY_REGISTRY_ADDRESS`, `DOGTAG_SBT_ADDRESS`, `VERIFICATION_REGISTRY_ADDRESS`, `DELEGATION_REGISTRY_ADDRESS`) are read from the container's own env when it STARTS, not baked into the image at `docker build` time - the running server injects them into every page it serves (`PublicConfigInitScript`, mirroring the DogTag admin portal's own chain-config mechanism), so the browser always sees this container's real values.
This is why step 4 above just works the first time: build the image once (no build args, no per-environment rebuild - see the Dockerfile's own comment on this) and push it anywhere; each environment supplies its own `.env` (or Helm `values.yaml`/Secret) at container start.
If you leave the four contract addresses blank for a first run, the setup wizard shows "Protocol addresses are not configured" instead of failing silently - set them (in `.env` for Compose, or the Helm values below) and restart the container, no rebuild required, and the wizard picks them up on the next request.

### Getting a public URL

DogTag QR codes (mint, verify, payment) and every email link this app sends embed `PUBLIC_BASE_URL`, so the app needs to be reachable at a real, stable URL before it is useful - not `localhost`.
Two ways to get one without owning server infrastructure:

- **A domain plus a reverse proxy you control**: point DNS at the box running `docker compose`, and put Cloudflare (recommended - see "Cloudflare" below) or your own TLS-terminating proxy in front of port 3000.
- **cloudflared tunnel** (recommended if you have no static IP or open inbound ports at all - typical for a clinic on a residential or small-business connection): see below.

#### cloudflared tunnel option

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) gives this app a public HTTPS URL with no port forwarding, no static IP, and Cloudflare's proxy (including the rate rules below) sitting in front of it for free.

1. Add your domain to Cloudflare (or use a subdomain of one you already manage there).
2. Install `cloudflared` on the same machine as `docker compose`, or run it as a fourth compose service pointed at `http://web:3000`.
3. Create a tunnel and a public hostname route for it: `cloudflared tunnel create dogtag-vet`, then `cloudflared tunnel route dns dogtag-vet vet.yourclinic.com`.
4. Point the tunnel's ingress rule at `http://localhost:3000` (or `http://web:3000` if run as a compose service).
5. Set `PUBLIC_BASE_URL=https://vet.yourclinic.com` and restart the stack.

No inbound firewall rule or port forward is needed anywhere in this path - `cloudflared` makes an outbound connection to Cloudflare, which is what a residential or clinic-office network almost always allows by default.

### Wallet gas for on-chain writes

There is no single stored "relayer wallet". Every on-chain write this app makes - issuing a tag or a record, revoking or reactivating one, relaying a verification signature, and (WP4.15) adding or revoking a secondary owner - is signed by whichever browser wallet is connected in that staff member's own session at the time (`TagIssueWizard`, `TagsTable`, `VerifySessionPanel`, `IssueRecordForm`, `RecordsCard`, `AddSecondaryOwnerAction`, and `RevokeSecondaryOwnerAction` each submit through their own connected wallet).
`ClinicSettings.operatorWallet` remembers only the last-connected address, for display continuity between visits - nothing reads it back to sign anything.
Whichever wallet submits a write needs its own native PLASMA balance to pay gas for it; gas is fronted by that wallet and refunded by the clinic's clone on success.
A failed attempt is not refunded - keep whichever wallets your staff actually use topped up rather than relying on refunds to cover the next attempt.

**Gas floors (1.4.1, incident 2026-09-25):** the app computes a gas limit for every one of these writes itself (`src/lib/chainWrite.ts`'s `legacyTxWithGas`) rather than letting the connected wallet estimate on its own - every write here ends in a gas-refund transfer back to the operator, and `eth_estimateGas` systematically undercounts that refund tail (it estimates at gas price 0, where the refund comes out to zero and its transfer is skipped, while the real send pays a real gas price and the transfer actually runs).
The app now enforces a hard per-function MINIMUM gas limit (a "floor") on top of its own estimate-based headroom, so a transaction can never go out under-provisioned even if the live estimate is wrong or unreachable: `issueTag`/`revokeTag`/`reactivateTag`/`issueRecord`/`revokeRecord` floor at 400,000 gas, `recordVerificationZK` at 350,000, `relayVerification` at 400,000, and the delegation writes `addSecondaryOwner`/`revokeSecondaryOwner` (which rebuild a 16-leaf Merkle tree through 15 linked `PoseidonT4` calls) at 1,600,000 and 1,500,000 respectively.
This never fails silently: if the app cannot get a live estimate at all (no public client, or the estimate call itself throws), it falls back to the floor and logs a `console.warn` naming the function and the reason - open the browser console after any wallet-gated write to check for one if a transaction ever looks under-provisioned.

If you are running an older image (built before this fix) against a workstation deployment, the equivalent manual workaround in MetaMask is: before confirming any DogTag write, click "Edit" on the gas fee screen and raise the gas LIMIT (not the gas price) to at least 500,000 for a tag/record write or 2,000,000 for an add/revoke-secondary-owner write, rather than accepting whatever MetaMask pre-fills - MetaMask's own pre-fill is exactly the bare, un-headroomed estimate this fix now overrides.

### Operator wallet funding (1.4.1, WP4.19)

Since the DogTag admin now funds every whitelisted issuance operator wallet directly (a base amount of native PLASMA on whitelisting, topped back up whenever it drops low - see `dogtag-admin`'s own DEPLOY.md for that half), a clinic should rarely need to manually fund a staff wallet at all.
This app's own share of "seamless gas" is entirely about SHOWING that state honestly, never about holding or moving funds itself - this repo still never holds a private key server-side, the same "no server-held private keys" rule the section above already states.

Two new environment values, both RUNTIME values injected into every page the same way as the five protocol addresses above (`PublicConfigInitScript`), never build-time-inlined alone:

- `OPERATOR_LOW_PLASMA` (default `0.1`) - the same low-balance threshold the admin funds operators against. Set it to match whatever value the admin deployment actually uses; a mismatch is not dangerous (both sides simply disagree about when to warn), but keeping them equal avoids a confusing "the admin already topped me up but the vet portal still calls it low" moment.
- `ADMIN_PORTAL_URL` - this clinic's own DogTag admin portal base URL, e.g. `https://admin.example-clinic.test`, no trailing slash. Used only for the "Request a top-up" button's deep link to the admin portal's status page (the SAME page step 3 below already sends staff to by hand for a whitelist request). Left blank, the button is replaced by plain instructions and a copyable wallet address instead of a broken link.

With both set, three things change on this app's own pages:

1. The "My issuance wallet" card (Settings) and the wallet banner on `/tags`, `/tags/issue`, and a pet's own page all show the CONNECTED operator wallet's live PLASMA balance, read straight from the public client, refreshed roughly every 15 seconds. Below `OPERATOR_LOW_PLASMA`, a warning appears next to it with the "Request a top-up" button.
2. After every clone write that confirms (issue, revoke, reactivate, a vaccination record, adding or revoking a secondary owner, and a clone-relayed consent verification), the app decodes the mined receipt's own logs and reports whether the clinic's clone actually refunded the gas: "Gas refunded by the clinic contract", or "Refund skipped, the clinic's refund pool is low: tell your admin" if the clone's own refund pool could not cover it. There is no `GasRefunded` event in this protocol snapshot - a successful refund is a bare native transfer with no event of its own, so "refunded" is read as the absence of a `RefundSkipped` log on that receipt, never a positive signal.
   A skipped refund is a DIFFERENT, unrelated low-balance condition from the wallet warning above - it means the clinic's clone (`setMaxRefund`'s own pool, funded by whoever deployed it, separate from any operator wallet) is short, not the operator's own wallet. Point staff at the clinic's admin/owner to fund the clone directly (the admin approve stepper's own "Optional PLASMA top-up" step, or a manual `cast send` to the clone) - a "Request a top-up" click from the vet side files an OPERATOR wallet top-up request, which does nothing for this.
3. Issuing, revoking, and reactivating a tag refuse to send outright when the connected wallet's balance cannot cover that specific write's own gas floor (see the floors listed above) at the CURRENT gas price, with the message "Your wallet needs about X PLASMA for this transaction; ask your admin for a top-up" and the same top-up request button, rather than letting the write reach the wallet and fail there with a generic "insufficient funds" error.

"Request a top-up" is a deep link to the admin portal's status page, never a request this app submits on the vet's behalf: the admin's own operator-request endpoint is gated by a session scoped to the clinic's admin-portal account, which this app has no way to hold or proxy.
Clicking it opens that page in a new tab; the vet (or whoever is signed into the admin portal for this clinic) still files the request there, the same "Issuance operators" section step 3 below already describes for a whitelist request - a `topup` request kind, reviewed and approved by the DogTag protocol admin the same way.

### Vet role, issuance operators, and per-practitioner scheduling

This section covers two related, Settings-page-only features - neither needs an environment variable or a redeploy.
Note the naming collision with "Wallet gas for on-chain writes" just above: that section is about paying gas from whichever browser wallet happens to be connected when a write is submitted.
This section is about a DIFFERENT, per-vet concept the app calls an "issuance operator" - a wallet the contract's `VetIssuer` clone whitelists to issue tags and records at all.
The two are unrelated; a staff member's wallet being an issuance operator does not give it any special gas-fronting role, and whichever wallet happened to complete setup does not need to also be an issuance operator.

**Granting a vet the ability to issue tags (WP4.16: through the DogTag admin portal, not this app):**

Only the DogTag protocol admin's own wallet may call `addOperator`/`removeOperator` on this clinic's `VetIssuer` clone - the contract enforces `onlyFactoryAdmin` on both functions, so no wallet this app ever connects (the clinic owner's, a vet's own) can submit either write, no matter what an older build of this page's UI implied.
This app's Settings page cannot grant or revoke that whitelist itself; the "Issuance operators" panel below only ever reads and displays the current on-chain answer.

1. Invite the staff member from Settings ("Invite by email"), choosing role Vet (or Owner, which already carries this ability).
   A plain Staff role can never issue tags or records, on any chain - `/tags` and `/tags/issue` redirect them, and the issuance, records and delegation API routes reject them with a 403, regardless of any on-chain whitelist state.
2. Record that staff member's wallet address in their "Practitioner profiles" entry below the staff roster (the "Wallet address" field) - this is informational, the address the admin's whitelist decision below is checked against, not something this app reads back to sign anything; whichever wallet the vet actually has connected in their browser is what submits their `issueTag`/`issueRecord` transactions.
   The vet does not need you for this step at all: once invited, they can record (or clear) their own wallet themselves from their own "My issuance wallet" card on Settings, including a "Use connected wallet" button that fills it from their own connected browser wallet - see the README's own section on this. Either path writes to the identical field; use whichever is more convenient for a given vet.
3. File the actual whitelist request in the DogTag admin portal, not here: sign in to the admin portal with this clinic's own account (the one used to apply for this clinic originally), go to its status page, and use the "Issuance operators" section there to submit the vet's details (name, title, accreditation number, and the SAME wallet address you just recorded in step 2) as a request to whitelist that wallet.
   The DogTag protocol admin reviews that queue and, when satisfied, approves it from their own admin session - that approval is what actually submits the `addOperator` transaction, signed by the admin's own wallet, never yours.
4. Wait for the admin's transaction to confirm; back in this app, the "Issuance operators" panel's row for that staff member flips from Inactive to Active once its `operators(address)` read reflects it - normally within a few seconds of the admin's transaction confirming (that panel runs its own independent, client-side `operators(address)` read; there is no shared cache with any other surface, each one - this panel, the vet's own "My issuance wallet" card, the `/tags`/`/tags/issue` banner - polls the chain on its own), with nothing further needed from you.
   The app's own role gate (`/tags`, `/tags/issue`, the issuance, records and delegation API routes) checks ONLY the app-side Vet/Owner role, not this on-chain grant - a Vet whose role is already set reaches those pages fine even before this step, but every actual issuance transaction they submit reverts on-chain until this grant lands, since the contract enforces its own operator whitelist independently of anything this app shows them.
5. To revoke a vet's issuance access, file the same kind of request in the admin portal (its request form's own "Remove this wallet's issuance access" option instead of the whitelist one) and wait for the admin to approve it the same way.
   This app has no self-service "Remove operator" action of its own any more - treat revocation as taking however long the admin takes to act on that request, not something you can do instantly the moment a vet leaves.
   Demoting a vet's app-side role to Staff (or disabling their account) is immediate and independent of this - do that right away when a vet leaves, and file the on-chain removal request separately, since the app-side role change alone does not touch the chain and the contract will keep honoring a stale operator grant until the admin actually revokes it.

The vet does not need to ask you whether step 4 has landed: their own "My issuance wallet" card on Settings, and a warning banner on `/tags`/`/tags/issue` whenever it does not yet say Whitelisted, both read the identical on-chain check this panel does, so they see the same Active/Whitelisted transition themselves within a few seconds of the admin's transaction confirming, with no extra step from either of you.

**Switching scheduling mode from Whole clinic to Per practitioner on a live deployment:**

This mode switch is safe to flip on a running clinic with existing data - it changes how NEW availability is computed and how the calendar displays appointments, and it does not rewrite, delete, or reinterpret anything already in the database.
Before switching, confirm at least one Staff row has role Vet or Owner, is marked "Bookable", and has at least one weekly-hours rule of their own set in the "Weekly hours" picker (select that practitioner from the picker above it first) - the Settings page refuses the switch with an explicit message until this is true, so there is no way to flip it into a broken state through the UI.
A database created before this feature existed also needs a one-time index migration: it still physically carries the old single-field unique index on `AvailabilityException.date` (Mongo never drops an index just because a schema stops declaring it), which keeps rejecting a second practitioner's exception on a date already taken until it is dropped. Check first, from a `mongosh` shell against this deployment's database: `db.availabilityexceptions.getIndexes().filter(i => i.name === "date_1")` - if the one result's `unique` field is `true`, run `db.availabilityexceptions.dropIndex("date_1")` once; a brand-new database (or one already migrated) has no `unique: true` index named `date_1` to find, so there is nothing to do. See `src/lib/models/Availability.ts`'s own "LIVE-DB MIGRATION NOTE" for the full detail, including why re-running the drop on an already-migrated database is safe to check for but harmful to run speculatively.
Any appointment that already exists with no practitioner assigned becomes "Unassigned" the moment the mode switches, and per D3's design it blocks that same time slot for every practitioner (never a silent double-book) until staff open it and assign one - expect a "Unassigned appointments need a practitioner" banner on the calendar immediately after switching if any such appointments fall in the visible date range, and treat clearing that banner (assigning a real practitioner to each) as the last step of the migration, not an optional cleanup.
If two or more of those legacy appointments land at the EXACT same instant (only possible if the Whole-clinic window's own capacity was ever set above 1), assigning any one of them will correctly refuse with a conflict for as long as any of the others at that same instant is still unassigned - D3 treats every unassigned appointment as blocking, including against each other, so the system will never silently pick a winner between two appointments competing for one practitioner's single slot. This is not a bug and not a sign the migration is stuck, and note that adding another bookable practitioner does NOT clear it - each unassigned appointment blocks every practitioner, including a newly added one, so both remain unassignable while both are live. Resolve it the way the software actually allows: cancel all but one of the overlapping appointments (an appointment's time cannot be edited after creation - there is no reschedule action, and a cancellation cannot be undone), then assign the remaining one normally. If a cancelled one still needs to happen, re-create it from the calendar with a practitioner chosen at creation time, which is a staff booking and so is allowed to sit alongside the existing one.
Switching back to Whole clinic at any time is equally safe and immediate - it simply stops consulting per-practitioner rules/exceptions and per-practitioner appointment assignment, reverting to the exact clinic-wide computation this app used before this feature existed; no data is lost either direction, so the switch can be rehearsed on a live deployment during a quiet period before committing to it.

## Kubernetes (Helm)

`helm/dogtag-vet/` deploys the web app and the worker as two Deployments; it does not manage MongoDB - see "Managed Mongo" below.

```
helm install dogtag-vet ./helm/dogtag-vet \
  --set image.web.repository=your-registry/dogtag-vet-web \
  --set image.web.tag=v1 \
  --set image.worker.repository=your-registry/dogtag-vet-worker \
  --set image.worker.tag=v1 \
  --set env.PUBLIC_BASE_URL=https://vet.yourclinic.com \
  --set env.MONGODB_URI=mongodb+srv://... \
  --set existingSecret=dogtag-vet-secrets
```

Build and push the two images first (`docker build -f Dockerfile -t your-registry/dogtag-vet-web:v1 .` and the same with `Dockerfile.worker`) - there is no public image for this app.
The web image needs no per-environment build (see "Protocol addresses and RPC config are runtime values" above): the SAME `v1` tag can be promoted from dev to staging to production, each supplying its own `env.VET_ISSUER_FACTORY_ADDRESS`/`env.ROAX_RPC_URL`/etc. (or a Secret key) at install time, exactly like `env.PUBLIC_BASE_URL` and `env.MONGODB_URI` in the example below - never a rebuild with different `--build-arg` values.

Sitting behind a reverse proxy or tunnel (Cloudflare Tunnel, nginx - every path this guide recommends) - which the "AUTH_TRUST_HOST" step of the Quickstart above already calls out as required for Compose - also applies here: add `--from-literal=AUTH_TRUST_HOST=1` to the `kubectl create secret` command below (never `--set env.AUTH_TRUST_HOST=1` in the same install alongside `existingSecret` - see `helm/dogtag-vet/values.yaml`'s own comment on why a container's plain `env:` entries shadow an `envFrom:` Secret for the same name), or Auth.js refuses to serve `/api/auth/*` at all.

Secrets (`AUTH_SECRET`, `AUTH_TRUST_HOST`, SMTP credentials, the Google OAuth client secret) do not belong in `values.yaml`, committed or otherwise.
Create the Secret yourself and reference it:

```
kubectl create secret generic dogtag-vet-secrets \
  --from-literal=AUTH_SECRET=$(openssl rand -base64 32) \
  --from-literal=AUTH_TRUST_HOST=1 \
  --from-literal=EMAIL_SERVER=smtp://user:pass@smtp.example.com:587
```

`helm/dogtag-vet/values.yaml` documents every value; `ingress.enabled` plus `ingress.host` wires up an Ingress if your cluster has a controller, otherwise reach the web Service directly or with your own Ingress/Gateway resource.
`helm/dogtag-vet/values-example.yaml` is a complete, documented example (fake addresses and URLs throughout) covering every value in this section, including the worker health port below - copy and edit it for a real install: `helm install dogtag-vet ./helm/dogtag-vet -f helm/dogtag-vet/values-example.yaml --set existingSecret=dogtag-vet-secrets`.
That example file sets `env.AUTH_TRUST_HOST` directly (to demonstrate the plain-value path) - if you also pass `--set existingSecret=...` pointing at a Secret that carries its own `AUTH_TRUST_HOST` (as the `kubectl create secret` command above now does), delete the `AUTH_TRUST_HOST` line from your copy of the values file first, per the "never both" rule two paragraphs up.

Verify the chart with `helm lint helm/dogtag-vet` and `helm template dogtag-vet ./helm/dogtag-vet` before installing against a real cluster.

### Worker health (`/healthz`, `/livez`)

The worker container serves `GET /healthz` (readiness - Mongo connectivity plus both background loops' recent progress, with the activity-follower cursor and per-chain payment watcher state) and `GET /livez` (liveness - both loops' recent progress only, never Mongo, so a database outage marks the worker not-ready instead of getting its container restarted) on `WORKER_HEALTH_PORT` (default 8091, `.env.example`).
The Helm chart's worker Deployment already wires both Kubernetes probes to these routes (`helm/dogtag-vet/values.yaml`'s `worker.healthPort`/`worker.stallMinutes`); Compose publishes the same port, so `curl localhost:8091/healthz` works against either.
A response reports `"status": "degraded"` (HTTP 503) once either loop has gone `WORKER_STALL_MINUTES` (default 10) without progress, or Mongo is unreachable - see `src/lib/health/workerHealth.ts` for exactly what "progress" means for each loop.

## Managed MongoDB

The Docker Compose path runs Mongo in a container with a Docker volume, which is fine for a single clinic and simple to back up (see "Backups" below), but a managed Mongo (MongoDB Atlas, or your cloud provider's managed offering) removes the database from your own operational surface entirely - no volume to babysit, automatic backups, easier scaling.

To use one: create a database and get its connection string.
For Helm, that is all - set `env.MONGODB_URI` (or a Secret key) to it instead of your own Mongo's URI.
For Compose, setting `MONGODB_URI` in `.env` is NOT enough on its own: `docker-compose.yml` hard-codes `MONGODB_URI` under `environment:` for both the `web` and `worker` services, and Compose's `environment:` block always overrides `env_file` - so the hard-coded value wins regardless of what `.env` says. Edit or remove those two `environment: MONGODB_URI` entries (and, since you no longer need the bundled database, the `depends_on: mongo` line and the `mongo` service and its volume) in `docker-compose.yml` itself before setting `MONGODB_URI` in `.env` to your managed connection string.
Nothing else in this app changes - it is plain `mongoose` against a standard connection string either way.

## Protecting your deployment

This code is open source and the APIs are known to everyone - a self-hosting vet (git clone + setup) needs perimeter protection beyond the in-process fixed-window limiter described below, because the booking/registration endpoints are open by design (the QR-based flows carry one-time tokens, but nothing gates who can even attempt to start one).
Treat everything in this section as a checklist to complete before pointing any real client traffic at a fresh deployment, not just background reading.

Every public API route (`/p/`, `/x/`, `/w/`, `/d/`, `/e/`, `/i/`, `/v/`, `/v1/booking/*`, `/v1/verify/consent`, `/v1/payments/*/public`, `/v1/entity`, `/r/pay/*`, `/profiles/issue/custodial-bind`) already rate-limits and caps request body size at the application layer (`src/lib/rateLimit.ts`, `src/lib/bodyLimit.ts`) and records rejected requests to an abuse log visible on the Settings page.
The client-facing HTML pages that front those routes - `/book` (the booking form) and `/booking/*` (the status/cancel page a confirmation email links to) - carry no application-layer rate limit of their own. `/book`'s own writes go through the limited API routes above; `/booking/{id}` is different - its initial render performs its own direct, token-checked read of the Appointment (`src/app/booking/[id]/page.tsx`), not a call through a rate-limited route, while its Cancel button does call the limited `POST /v1/booking/appointments/{id}/cancel`. Both pages are unauthenticated page-loads guarded only by a per-appointment token in the URL, so rely on the Cloudflare/nginx tier below for their rate limiting, the same as the token-guessing surface it already covers.
That log keys each entry by the requester's IP address and self-prunes after 14 days, which is the entirety of this deployment's retention policy for that data.
A reverse proxy in front of the app is still worth having, both to absorb traffic before it reaches this single Node process at all and for TLS termination.

**This limiter is per-process, in-memory, and resets on restart** - it stops a single abusive caller from overwhelming ONE running instance, but it has no visibility across multiple instances (a horizontally-scaled deployment) and no persistence.
If you ever run more than one instance of this app behind a load balancer, the per-process limiter stops being an accurate shared count - the documented upgrade path is to move `src/lib/rateLimit.ts`'s counters into Redis (or an equivalent shared store) so every instance enforces the same limit against the same counter, rather than each instance separately allowing its own share of the traffic through.
This is not implemented in this codebase today; it is named here so a deployment that actually needs to scale horizontally knows what to build before it does, rather than discovering the gap under load.
A single-instance deployment (the Docker Compose quickstart this project is built around) does not need this - the in-process limiter is the right tool for it.

**What an attack looks like**: a burst of requests against `/v1/booking/book`, `/profiles/issue/custodial-bind`, or a `/p/`/`/x/`/`/w/` token-guessing attempt shows up as a spike of rejected-request entries in the AbuseLog collection (Settings page), keyed by IP and reason (`rate_limited`, `body_too_large`).
A normal clinic's traffic produces a near-empty log; a sudden run of entries from one IP (or a small rotating set, if `TRUSTED_PROXY_HOPS` is configured correctly and the attacker isn't actually behind Cloudflare) is the signal to look at Cloudflare's own analytics for the same window and consider tightening the WAF rules below or enabling Attack Mode / "I'm Under Attack" mode for the domain.

### Trusted proxy hops (X-Forwarded-For)

`X-Forwarded-For` is a header any CLIENT can set to anything it wants - a reverse proxy in front of this app only ever APPENDS to it (nginx's `proxy_add_x_forwarded_for`, used below, does exactly this), so whatever a client sent stays present, untouched, to the left of what the proxy chain adds. Reading the wrong entry from this header is a real vulnerability, not just an inaccuracy: keying a per-IP rate limit on the client-controlled leftmost entry lets an attacker bypass it completely by rotating that value on every request.

This app never trusts the leftmost entry. Instead:

- `CF-Connecting-IP`, when present, is used first - Cloudflare sets this itself (see "Cloudflare" below) and it cannot be forged by a client proxied through Cloudflare's edge.
- Otherwise, `TRUSTED_PROXY_HOPS` (`.env.example`, default `0`) says how many reverse-proxy hops directly in front of this app are trusted to have faithfully appended the real peer address - the client key is read from that many entries counted **from the right** of `X-Forwarded-For`. A single nginx (or any other) reverse proxy directly in front of this app - the setup both the nginx snippet below and the standard Cloudflare-proxied path produce - means exactly one trusted hop: set `TRUSTED_PROXY_HOPS=1`, and the RIGHTMOST entry (the one that hop actually appended) is what gets trusted.
- With `TRUSTED_PROXY_HOPS` left at `0` (or set higher than the number of entries actually present), `X-Forwarded-For` is not trusted at all - every caller collapses into one shared bucket, which is safe (nothing a client sends can escape it) but coarse (one abusive caller can also 429 every other visitor). Set this correctly for your deployment; do not leave it at the default behind a real reverse proxy.

### Cloudflare

This is the recommended perimeter for any deployment reachable over the public internet - orange-cloud the domain (DNS record proxied through Cloudflare, which the `cloudflared` tunnel path above sets up automatically) and configure:

1. **Never expose the origin IP, and firewall it to Cloudflare only.**
   Orange-clouding a DNS record hides this app's real IP from ordinary DNS lookups, but that protection is worthless if the IP leaks another way (a stale A record from before you enabled the proxy, a server error page that reveals it, a different subdomain left un-proxied) or if the origin's own firewall still accepts connections from anywhere.
   Configure your host's firewall (or, on the `cloudflared` tunnel path above, rely on the tunnel making only outbound connections - there is no listening inbound port to protect at all) to accept inbound traffic on the app's port ONLY from [Cloudflare's published IP ranges](https://www.cloudflare.com/ips/), and audit that no other DNS record for the same domain points at the origin directly.
   An attacker who finds the origin IP can bypass every Cloudflare rule below entirely by connecting straight to it.
2. **Rate limiting rules** (Security > WAF > Rate limiting rules) - add a rule per sensitive path group, tighter than the application's own limits so abusive traffic is stopped at the edge instead of reaching this process at all:
   - `/v1/booking/book`, `/profiles/issue/custodial-bind`, `/v1/verify/consent` (the write/session-start endpoints): a low limit, e.g. 5 requests per minute per IP.
   - `/p/*`, `/x/*`, `/w/*`, `/d/*`, `/e/*`, `/i/*`, `/v/*`, `/v1/booking/appointments/*`, `/booking/*` (token-guessing surface): a moderate limit, e.g. 20 requests per minute per IP - `/v1/booking/appointments/{id}` and its `/cancel` companion, and the WP4.9-to-4.15 single-use ceremony routes `/d/*` (delegation), `/e/*` (tag and record export - one route serves both), `/i/*` (tag import), and `/v/*` (records verify, present-to-clinic), are all gated by the same kind of per-resource token as `/p/`/`/x/`/`/w/`, so they belong in this tier, not the general one below; a rotating, unguessable token is the real defense in every case here, the rate limit is defense in depth, not the only control.
   - `/book` (the public booking form page itself, as opposed to the `/v1/booking/*` API it calls): Cloudflare's default rate limiting is usually sufficient - it is a page render, not a write.
   - Everything else under `/v1/*` and `/r/*` (including the read-only `/v1/booking/availability` and `/v1/booking/services`): Cloudflare's default rate limiting is usually sufficient; add a rule only if you see abuse in the logs.
3. **Bot Fight Mode** (Security > Bots) - turn it on.
   It challenges automated traffic hitting the public mint/verify/booking pages without affecting the DogTag mobile app or a browser filling out the booking form normally.
4. **Challenge pages** for the same sensitive path group as the rate-limiting rules above (Security > WAF > Custom rules - a rule matching those paths with the action set to "Managed Challenge" rather than "Block") give a real browser or the DogTag app's own well-behaved traffic a chance to pass (a JS challenge / device check) while stopping a simple scripted flood outright, without permanently blocking an IP a legitimate client might later share (e.g. behind carrier-grade NAT).
   Reserve outright blocking for IPs you have already confirmed are abusive from the AbuseLog evidence above.

Cloudflare's `CF-Connecting-IP` header is used automatically (see "Trusted proxy hops" above) - it takes priority over `X-Forwarded-For`, so `TRUSTED_PROXY_HOPS` does not need to be set for a purely Cloudflare-proxied deployment. Still set it if this app also sits behind an additional reverse proxy of your own between Cloudflare and this process.

### nginx fallback (no Cloudflare, no managed WAF)

For a bare deployment behind a plain nginx reverse proxy, this snippet mirrors the tiered limits above:

```nginx
limit_req_zone $binary_remote_addr zone=dogtag_strict:10m rate=5r/m;
limit_req_zone $binary_remote_addr zone=dogtag_tokens:10m rate=20r/m;
limit_req_zone $binary_remote_addr zone=dogtag_general:10m rate=60r/m;

server {
    listen 443 ssl;
    server_name vet.yourclinic.com;

    # ... ssl_certificate, ssl_certificate_key, etc.

    location ~ ^/(v1/booking/book|profiles/issue/custodial-bind|v1/verify/consent) {
        limit_req zone=dogtag_strict burst=5 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ~ ^/(p|x|w|d|e|i|v)/ {
        limit_req zone=dogtag_tokens burst=10 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        limit_req zone=dogtag_general burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`X-Forwarded-For` is what `src/lib/rateLimit.ts` reads to key its own per-IP limits, so setting it correctly here matters even beyond nginx's own `limit_req`. `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` appends the real peer nginx saw to the RIGHT of whatever the client sent - set `TRUSTED_PROXY_HOPS=1` in `.env` for this single-nginx-hop setup so the app trusts exactly that rightmost entry (see "Trusted proxy hops" above). Leaving `TRUSTED_PROXY_HOPS` at its default of `0` with this nginx config in front of it means the app's own rate limits fall back to one shared bucket for every caller - nginx's `limit_req` above still applies either way, but the application-layer limits lose their per-IP granularity.

## Backups

Everything this app owns lives in one Mongo database - client and pet records, appointments, mint and verify sessions, payments, and pet-photo/PDF blobs (`StoredFile`, stored as documents, not on disk) - so backing up Mongo is backing up the whole deployment.
No other volume or directory needs a backup strategy of its own.

- **Docker Compose (self-run Mongo)**: `docker compose exec mongo mongodump --archive=/data/db/backup-$(date +%F).gz --gzip --db dogtag-vet`, then copy that file off the host on whatever schedule you're comfortable with (a nightly cron calling this and syncing to off-host storage is enough for a single clinic).
  Restore with `mongorestore --archive=<file> --gzip`.
- **Managed Mongo**: use the provider's built-in backup/snapshot feature (Atlas has automatic continuous backups on every paid tier) instead of `mongodump` - it is more reliable and does not require you to manage the schedule yourself.

Restore into a fresh `docker compose up -d` (or Helm install) by running `mongorestore` against the new instance's `MONGODB_URI` before opening the app for the first time.
A restored database already carries its own chain identity, staff accounts, and everything else in `ClinicSettings`, so there is no setup wizard to redo - sign in and continue where the backup left off.
