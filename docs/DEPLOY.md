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
   - `VET_ISSUER_FACTORY_ADDRESS`, `ENTITY_REGISTRY_ADDRESS`, `DOGTAG_SBT_ADDRESS`, `VERIFICATION_REGISTRY_ADDRESS` - the protocol contract addresses on ROAX (and their `NEXT_PUBLIC_` mirrors).

   `.env.example` documents every other value and its default; leave the rest alone until you have a specific reason to change them.
3. Start the stack.
   ```
   docker compose up -d
   ```
   This builds the web image and the worker image, starts a Mongo container with a persistent volume, and starts both app processes.
4. Open `http://localhost:3000` (or wherever `PUBLIC_BASE_URL` points) and complete the setup wizard: sign in, connect a wallet, and let the wizard discover this clinic's clone.

That's it for a first run.
Everything else - receiving addresses for payments, the business profile card, chain RPC overrides - is configured from the running app's Settings page, not from environment variables, so it can change without a redeploy.

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

### Operator wallet gas

The wallet you connect during setup submits every on-chain write this app makes - issuing a tag, revoking or reactivating one, and relaying a verification signature - so it needs a native PLASMA balance to pay gas.
Gas is fronted by that operator wallet and refunded by the clinic's clone on success.
A failed attempt is not refunded - keep the wallet topped up rather than relying on refunds to cover the next attempt.

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

Secrets (`AUTH_SECRET`, SMTP credentials, the Google OAuth client secret) do not belong in `values.yaml`, committed or otherwise.
Create the Secret yourself and reference it:

```
kubectl create secret generic dogtag-vet-secrets \
  --from-literal=AUTH_SECRET=$(openssl rand -base64 32) \
  --from-literal=EMAIL_SERVER=smtp://user:pass@smtp.example.com:587
```

`helm/dogtag-vet/values.yaml` documents every value; `ingress.enabled` plus `ingress.host` wires up an Ingress if your cluster has a controller, otherwise reach the web Service directly or with your own Ingress/Gateway resource.

Verify the chart with `helm lint helm/dogtag-vet` and `helm template dogtag-vet ./helm/dogtag-vet` before installing against a real cluster.

## Managed MongoDB

The Docker Compose path runs Mongo in a container with a Docker volume, which is fine for a single clinic and simple to back up (see "Backups" below), but a managed Mongo (MongoDB Atlas, or your cloud provider's managed offering) removes the database from your own operational surface entirely - no volume to babysit, automatic backups, easier scaling.

To use one: create a database, get its connection string, and set `MONGODB_URI` to it (in `.env` for Compose, or `env.MONGODB_URI` / a Secret key for Helm) instead of the compose-provided `mongodb://mongo:27017/dogtag-vet`.
Nothing else in this app changes - it is plain `mongoose` against a standard connection string either way.
If you switch to a managed Mongo under Docker Compose, you can also drop the `mongo` service and its volume from `docker-compose.yml` entirely.

## Protecting your deployment

This code is open source and the APIs are known to everyone - a self-hosting vet (git clone + setup) needs perimeter protection beyond the in-process fixed-window limiter described below, because the booking/registration endpoints are open by design (the QR-based flows carry one-time tokens, but nothing gates who can even attempt to start one).
Treat everything in this section as a checklist to complete before pointing any real client traffic at a fresh deployment, not just background reading.

Every public API route (`/p/`, `/x/`, `/w/`, `/v1/booking/*`, `/v1/verify/consent`, `/v1/payments/*/public`, `/v1/entity`, `/r/pay/*`, `/profiles/issue/custodial-bind`) already rate-limits and caps request body size at the application layer (`src/lib/rateLimit.ts`, `src/lib/bodyLimit.ts`) and records rejected requests to an abuse log visible on the Settings page.
The client-facing HTML pages that front those routes - `/book` (the booking form) and `/booking/*` (the status/cancel page a confirmation email links to) - carry no application-layer rate limit of their own; they are static-ish page renders, and every write or lookup they trigger goes through the limited API routes above, so the exposure is the same page-load cost any public page has.
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
   - `/p/*`, `/x/*`, `/w/*`, `/v1/booking/appointments/*`, `/booking/*` (token-guessing surface): a moderate limit, e.g. 20 requests per minute per IP - `/v1/booking/appointments/{id}` and its `/cancel` companion are gated by the same kind of per-resource token as `/p/`/`/x/`/`/w/`, so they belong in this tier, not the general one below; a rotating, unguessable token is the real defense in every case here, the rate limit is defense in depth, not the only control.
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

    location ~ ^/(p|x|w)/ {
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
