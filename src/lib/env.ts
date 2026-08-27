// `server-only`'s package.json maps the `react-server` export condition to a no-op stub and
// everything else (including plain Node) to a throwing one - Next's own bundler sets that
// condition automatically for server components, but a standalone script run via plain `tsx`
// (scripts/seed.ts, src/worker/index.ts) does not. Both of those scripts are run with
// `tsx --conditions=react-server` (see package.json) specifically so importing this file - or
// anything that transitively imports it, like src/lib/db.ts - doesn't throw outside Next.
import "server-only";
import {z} from "zod";

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

  // Invoicing
  INVOICE_NUMBER_PREFIX: z.string().default("INV"),

  // Payment confirmation depth
  CONFIRMATIONS_MAINNET: z.coerce.number().default(3),
  CONFIRMATIONS_TESTNET: z.coerce.number().default(2),
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
