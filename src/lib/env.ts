// `server-only`'s package.json maps the `react-server` export condition to a no-op stub and
// everything else (including plain Node) to a throwing one - Next's own bundler sets that
// condition automatically for server components, but a standalone script run via plain `tsx`
// (scripts/seed.ts, src/worker/index.ts) does not. Both of those scripts are run with
// `tsx --conditions=react-server` (see package.json) specifically so importing this file - or
// anything that transitively imports it, like src/lib/db.ts - doesn't throw outside Next.
import "server-only";
import {z} from "zod";
import {DEFAULT_TOKEN_ADDRESSES} from "@/lib/payments/tokenTable";

/**
 * Typed server-side environment configuration.
 *
 * Deliberately lazy: `next build` (and every statically-analyzable page in this app) must
 * succeed on a bare checkout with no `.env` file present, so nothing here parses or throws at
 * module-evaluation time. Every field is optional or defaulted at the schema level; a route or
 * lib function that truly cannot proceed without a value (e.g. sending mail with no SMTP
 * configured) calls `requireEnv` for that one field at the moment it is needed, producing a
 * clear runtime error instead of a build-time crash or a silent no-op.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Dev-only credentials sign-in. Documented in README/DEPLOY as never for production use.
  DEV_LOGIN: z.string().optional(),

  // Persistence
  MONGODB_URI: z.string().optional(),

  // Auth.js v5
  AUTH_SECRET: z.string().optional(),
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),
  AUTH_TRUST_HOST: z.string().optional(),

  // Email (magic link sign-in + booking/payment/receipt notifications)
  EMAIL_SERVER: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  // Public-facing origin this deployment is served from - used to build mint/verify QR URLs,
  // booking confirmation links, and the receipt URL (specs/qr-formats.md).
  PUBLIC_BASE_URL: z.string().optional(),

  // Number of reverse-proxy hops in front of this app that are trusted to have faithfully
  // APPENDED (never replaced) the peer address they saw to `X-Forwarded-For` - see
  // `src/lib/rateLimit.ts`'s `clientKeyFromRequest` doc comment and `docs/DEPLOY.md`'s "Trusted
  // proxy hops" section. Defaults to 0 (trust nothing in `X-Forwarded-For`) because an
  // untrustworthy value here is a security bug (a client can put anything it wants in that
  // header), not just an inaccuracy - every real deployment behind the reverse proxies this app's
  // own docs recommend should set this explicitly (1 for a single nginx/Cloudflare hop).
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

  // ROAX (identity chain, chainId 135) - always legacy tx type, per architecture-v2.md.
  ROAX_RPC_URL: z.string().default("https://roax-testnet-rpc.dogtag.example/rpc"),
  ROAX_CHAIN_ID: z.coerce.number().default(135),
  ROAX_EXPLORER_URL: z.string().default("https://roax-testnet.blockscout.example"),

  // Payment chain RPC overrides - defaults per wp4-vet.md.
  ETHEREUM_RPC_URL: z.string().default("https://ethereum-rpc.publicnode.com"),
  BASE_RPC_URL: z.string().default("https://base-rpc.publicnode.com"),
  SEPOLIA_RPC_URL: z.string().default("https://ethereum-sepolia-rpc.publicnode.com"),
  BASE_SEPOLIA_RPC_URL: z.string().default("https://base-sepolia-rpc.publicnode.com"),

  // Protocol contract addresses this deployment talks to. Left unset until the setup wizard (or
  // an operator) supplies them; onboarding reads treat an unset factory address as "not
  // configured yet", never as address(0) on chain.
  VET_ISSUER_FACTORY_ADDRESS: z.string().optional(),
  ENTITY_REGISTRY_ADDRESS: z.string().optional(),
  DOGTAG_SBT_ADDRESS: z.string().optional(),
  VERIFICATION_REGISTRY_ADDRESS: z.string().optional(),
  // WP4.15 (PLANNED - the contract does not exist on any real chain yet; deployment is Kenneth's
  // own action per docs/DEPLOY-wp4.15.md in the protocol branch). Only ever needed SERVER-side:
  // the browser write targets `settings.cloneAddress` (the clinic's OWN clone, already fetched via
  // `/api/settings`) and never calls DelegationRegistry directly - the clone calls it internally
  // (`VetIssuer.addSecondaryOwner`/`revokeSecondaryOwner`). This address is read only by the
  // server's own confirm/status chain reads (`isSecondary`/`secondaryCount`/`delegationRoot`/
  // `delegationLeaves`), so unlike the other four addresses above it has no `NEXT_PUBLIC_` twin.
  DELEGATION_REGISTRY_ADDRESS: z.string().optional(),

  // Invoicing
  INVOICE_NUMBER_PREFIX: z.string().default("INV"),

  // Payment confirmation depth
  CONFIRMATIONS_MAINNET: z.coerce.number().default(3),
  CONFIRMATIONS_TESTNET: z.coerce.number().default(2),

  // ERC-20 contract addresses per (chain, token) - src/lib/payments/tokenRegistry.ts. Ethereum and
  // Base values are Circle's/Tether's real deployments; the three testnet USDT slots have no
  // canonical issuer deployment, so their defaults are clearly-marked placeholders (documented in
  // tokenRegistry.ts) that an operator MUST override before ever toggling that rail on for a real
  // invoice.
  TOKEN_USDC_ETHEREUM_ADDRESS: z.string().default(DEFAULT_TOKEN_ADDRESSES.usdcEthereum),
  TOKEN_USDC_BASE_ADDRESS: z.string().default(DEFAULT_TOKEN_ADDRESSES.usdcBase),
  TOKEN_USDC_SEPOLIA_ADDRESS: z.string().default(DEFAULT_TOKEN_ADDRESSES.usdcSepolia),
  TOKEN_USDC_BASE_SEPOLIA_ADDRESS: z.string().default(DEFAULT_TOKEN_ADDRESSES.usdcBaseSepolia),
  TOKEN_USDT_ETHEREUM_ADDRESS: z.string().default(DEFAULT_TOKEN_ADDRESSES.usdtEthereum),
  TOKEN_USDT_BASE_ADDRESS: z.string().default(DEFAULT_TOKEN_ADDRESSES.usdtBasePlaceholder),
  TOKEN_USDT_SEPOLIA_ADDRESS: z.string().default(DEFAULT_TOKEN_ADDRESSES.usdtSepoliaPlaceholder),
  TOKEN_USDT_BASE_SEPOLIA_ADDRESS: z.string().default(DEFAULT_TOKEN_ADDRESSES.usdtBaseSepoliaPlaceholder),

  // CoinGecko simple-price API (no key required) - src/lib/payments/priceFeed.ts.
  COINGECKO_API_BASE: z.string().default("https://api.coingecko.com/api/v3"),

  // Payment watcher (src/worker/index.ts) - separate loop from the chain-activity follower above.
  PAYMENT_WATCHER_POLL_MS: z.coerce.number().default(30_000),
  PAYMENT_ACTIVITY_CHUNK_BLOCKS: z.coerce.number().default(2000),

  // Chain-activity follower (src/worker/index.ts). Defaults to 0 (scan from genesis) - ROAX is a
  // dedicated, low-volume identity chain, so a full-history scan on first run is cheap; a
  // deployment onboarding onto a much taller chain should set this to its clone's actual deploy
  // block instead of paying for a genesis-to-tip scan it doesn't need.
  ACTIVITY_START_BLOCK: z.coerce.number().default(0),
  ACTIVITY_POLL_MS: z.coerce.number().default(15_000),
  ACTIVITY_CHUNK_BLOCKS: z.coerce.number().default(2000),

  // Worker boot recovery (src/worker/index.ts's recoverInterruptedSessions): how long a
  // MintSession may sit `issuing` before it is considered stale enough to act on. wp4-vet.md
  // itself calls this recovery step "stale" - a seconds-old in-flight `issueTag` transaction from
  // a process that is still very much alive must be left alone.
  MINT_SESSION_STALE_MS: z.coerce.number().default(5 * 60_000),

  // WP4.15 multi-owner (PLANNED). Boot recovery for a DelegationSession a previous worker process
  // left "submitting" mid-flight (src/lib/delegation/bootRecovery.ts) - same rationale and default
  // as MINT_SESSION_STALE_MS above, measured from `submittingAt`.
  DELEGATION_SESSION_STALE_MS: z.coerce.number().default(5 * 60_000),
});

export type ServerEnv = z.infer<typeof envSchema>;

let cached: ServerEnv | undefined;

/** Parsed, defaulted server env. Safe to call anywhere at runtime (route handlers, server
 * components, worker scripts); never throws - fields that are genuinely required for a specific
 * operation are checked by `requireEnv` at the call site instead. */
export function getServerEnv(): ServerEnv {
  if (!cached) {
    cached = envSchema.parse(process.env);
  }
  return cached;
}

/** Read one field from the parsed env and throw a clear, operator-facing error if it is unset.
 * Use this only for fields with no schema default, at the point a feature actually needs them
 * (e.g. `requireEnv("MONGODB_URI")` inside the Mongo connector, not at import time). */
export function requireEnv<K extends keyof ServerEnv>(key: K): NonNullable<ServerEnv[K]> {
  const value = getServerEnv()[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(
      `Missing required environment variable ${key}. See .env.example for the full list.`,
    );
  }
  return value as NonNullable<ServerEnv[K]>;
}

/** Whether the dev-only credentials sign-in provider should be registered. Never true unless the
 * operator explicitly opted in - this provider is documented as dev/test-only and must never be
 * reachable in a real deployment by omission. */
export function isDevLoginEnabled(): boolean {
  return getServerEnv().DEV_LOGIN === "1";
}
