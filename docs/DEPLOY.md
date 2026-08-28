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

## Public API protection

Every public route (`/p/`, `/x/`, `/v1/booking/*`, `/v1/verify/consent`, `/v1/payments/*/public`, `/v1/entity`, `/r/pay/*`, `/profiles/issue/custodial-bind`) already rate-limits and caps request body size at the application layer (`src/lib/rateLimit.ts`, `src/lib/bodyLimit.ts`) and records rejected requests to an abuse log visible on the Settings page.
That log keys each entry by the requester's IP address (read from `X-Forwarded-For`, so it is only as accurate as whatever reverse proxy you put in front of this app - see the `X-Forwarded-For` note below) and self-prunes after 14 days, which is the entirety of this deployment's retention policy for that data.
A reverse proxy in front of the app is still worth having, both to absorb traffic before it reaches this single Node process at all and for TLS termination.

### Cloudflare

If you are proxying through Cloudflare (orange-clouded DNS record, which the cloudflared tunnel path above uses automatically), two settings are worth configuring:

1. **Rate limiting rules** (Security > WAF > Rate limiting rules) - add a rule per sensitive path group, tighter than the application's own limits so abusive traffic is stopped at the edge instead of reaching this process at all:
   - `/v1/booking/book`, `/profiles/issue/custodial-bind`, `/v1/verify/consent` (the write/session-start endpoints): a low limit, e.g. 5 requests per minute per IP.
   - `/p/*`, `/x/*` (token-guessing surface): a moderate limit, e.g. 20 requests per minute per IP - these are also where a rotating, unguessable 32-hex token is the real defense; the rate limit is defense in depth, not the only control.
   - Everything else under `/v1/*` and `/r/*`: Cloudflare's default rate limiting is usually sufficient; add a rule only if you see abuse in the logs.
2. **Bot Fight Mode** (Security > Bots) - turn it on.
   It challenges automated traffic hitting the public mint/verify/booking pages without affecting the DogTag mobile app or a browser filling out the booking form normally.

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

    location ~ ^/(p|x)/ {
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

`X-Forwarded-For` is what `src/lib/rateLimit.ts` reads to key its own per-IP limits, so setting it correctly here matters even beyond nginx's own `limit_req`.

## Backups

Everything this app owns lives in one Mongo database - client and pet records, appointments, mint and verify sessions, payments, and pet-photo/PDF blobs (`StoredFile`, stored as documents, not on disk) - so backing up Mongo is backing up the whole deployment.
No other volume or directory needs a backup strategy of its own.

- **Docker Compose (self-run Mongo)**: `docker compose exec mongo mongodump --archive=/data/db/backup-$(date +%F).gz --gzip --db dogtag-vet`, then copy that file off the host on whatever schedule you're comfortable with (a nightly cron calling this and syncing to off-host storage is enough for a single clinic).
  Restore with `mongorestore --archive=<file> --gzip`.
- **Managed Mongo**: use the provider's built-in backup/snapshot feature (Atlas has automatic continuous backups on every paid tier) instead of `mongodump` - it is more reliable and does not require you to manage the schedule yourself.

Restore into a fresh `docker compose up -d` (or Helm install) by running `mongorestore` against the new instance's `MONGODB_URI` before opening the app for the first time.
A restored database already carries its own chain identity, staff accounts, and everything else in `ClinicSettings`, so there is no setup wizard to redo - sign in and continue where the backup left off.
