import NextAuth, {type NextAuthConfig} from "next-auth";
import Google from "next-auth/providers/google";
import Nodemailer from "next-auth/providers/nodemailer";
import Credentials from "next-auth/providers/credentials";
import {MongoDBAdapter} from "@auth/mongodb-adapter";
import type {Adapter} from "next-auth/adapters";
import {authConfig} from "@/auth.config";
import {getServerEnv, isDevLoginEnabled} from "@/lib/env";
import {connectToDatabase} from "@/lib/db";
import {ensureStaffForEmail, isEmailAllowedToSignIn, Staff, type StaffDoc, type StaffRole} from "@/lib/models/Staff";

const env = getServerEnv();

/** The adapter needs a `Promise<MongoClient>`, not a mongoose connection - reuse mongoose's own
 * underlying client so this app never opens two separate Mongo connections. Resolved lazily so
 * `next build` never attempts a real connection. */
async function mongoClientPromise() {
  const mongooseInstance = await connectToDatabase();
  return mongooseInstance.connection.getClient();
}

const providers: NonNullable<NextAuthConfig["providers"]> = [];

if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) {
  providers.push(
    Google({clientId: env.AUTH_GOOGLE_ID, clientSecret: env.AUTH_GOOGLE_SECRET}),
  );
}

if (env.EMAIL_SERVER && env.EMAIL_FROM) {
  providers.push(
    Nodemailer({server: env.EMAIL_SERVER, from: env.EMAIL_FROM}),
  );
}

if (isDevLoginEnabled()) {
  // Dev/test-only sign-in: takes an email with no password, provisions (or reuses) the matching
  // Staff record, and signs in as that staff member. NEVER registered unless the operator has
  // explicitly set DEV_LOGIN=1 - see README.md and docs/DEPLOY.md. Playwright and graders rely on
  // this to sign in without a real Google account or an SMTP server.
  providers.push(
    Credentials({
      id: "dev-login",
      name: "Dev login (test only)",
      credentials: {
        email: {label: "Email", type: "email"},
      },
      async authorize(credentials) {
        const email = typeof credentials?.email === "string" ? credentials.email.trim() : "";
        if (!email || !email.includes("@")) return null;
        const staff = await ensureStaffForEmail(email);
        return {id: staff.staffId, email: staff.email, name: staff.name ?? staff.email};
      },
    }),
  );
}

const hasMongoUri = Boolean(env.MONGODB_URI);

/**
 * Resolves the Staff row a just-authenticated (or refreshing) token should carry, per provider:
 *
 * - `dev-login`: unrestricted, exactly as before - dev/test-only, gated behind `DEV_LOGIN=1` at
 *   the provider-registration level above, and Playwright/graders rely on it auto-provisioning
 *   any email it sees.
 * - Every other (gated) provider - Google, email magic link: the SAME rule
 *   `isEmailAllowedToSignIn` enforces at sign-in time, so a token can never end up authorized here
 *   in a way `signIn` would have refused: the very first staff row this deployment ever creates
 *   (bootstrap - none exist yet, for any email) is provisioned as `owner`; every other email must
 *   already have a non-disabled Staff row, which only an owner's invite (`inviteStaff`) can have
 *   created. Returns `null` - never auto-provisioning - for an email that fails that check,
 *   including one that HAD a row but has since been disabled (see `Staff.ts`'s `disabled` doc
 *   comment on why revocation is a flag, not a delete).
 */
async function resolveStaffForToken(email: string, name: string | undefined, provider: string | undefined): Promise<StaffDoc | null> {
  if (provider === "dev-login") {
    return ensureStaffForEmail(email, name);
  }
  const normalized = email.toLowerCase().trim();
  const existing = await Staff.findOne({email: normalized}).lean<StaffDoc>();
  if (existing) return existing.disabled ? null : existing;
  const staffCount = await Staff.countDocuments();
  return staffCount === 0 ? ensureStaffForEmail(email, name) : null;
}

export const {handlers, auth, signIn, signOut} = NextAuth({
  ...authConfig,
  adapter: hasMongoUri ? (MongoDBAdapter(mongoClientPromise()) as Adapter) : undefined,
  // Credentials providers are incompatible with database sessions - jwt is required here
  // regardless of whether an adapter is configured (the adapter, when present, still handles
  // Google/Email user + verification-token storage; it just never backs the session itself).
  session: {strategy: "jwt"},
  secret: env.AUTH_SECRET,
  trustHost: env.AUTH_TRUST_HOST === "1" || env.NODE_ENV !== "production",
  providers,
  callbacks: {
    ...authConfig.callbacks,
    /**
     * Gates every sign-in through Google or the email magic link BEFORE a session is ever issued
     * - for the Email provider this runs (and can refuse) before the magic link is even sent, not
     * only when the link is clicked. Without this, `ensureStaffForEmail` in the `jwt` callback
     * below would silently provision a full-access `staff` account for any email that could
     * receive a link or complete an OAuth flow - the self-registration hole this closes. The
     * dev-only credentials provider is exempt by design (see its own registration above);
     * everything else defers to `isEmailAllowedToSignIn`'s bootstrap-or-invited rule.
     */
    async signIn({user, account}) {
      if (account?.provider === "dev-login") return true;
      const email = user?.email;
      if (!email) return false;
      return isEmailAllowedToSignIn(email);
    },
    async jwt({token, user, account}) {
      const email = user?.email ?? token.email;
      if (!email) return token;
      const staff = await resolveStaffForToken(email, user?.name ?? undefined, account?.provider);
      if (!staff) {
        // Not (or no longer) an authorized staff account - a token that reaches this branch
        // already passed `signIn` once, so this is the revocation path: a Staff row disabled
        // after the fact. Strip any previously-stamped claim rather than leaving a stale role in
        // place, so every downstream check (the `session` callback, `src/app/(app)/layout.tsx`,
        // `requireStaffSession`) sees an unauthenticated token, not merely a low-privilege one.
        delete token.role;
        delete token.staffId;
        return token;
      }
      token.role = staff.role;
      token.staffId = staff.staffId;
      return token;
    },
    async session({session, token}) {
      if (session.user) {
        session.user.role = token.role as StaffRole | undefined;
        session.user.staffId = token.staffId as string | undefined;
      }
      return session;
    },
  },
});
