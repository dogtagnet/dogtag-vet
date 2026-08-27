import NextAuth, {type NextAuthConfig} from "next-auth";
import Google from "next-auth/providers/google";
import Nodemailer from "next-auth/providers/nodemailer";
import Credentials from "next-auth/providers/credentials";
import {MongoDBAdapter} from "@auth/mongodb-adapter";
import type {Adapter} from "next-auth/adapters";
import {authConfig} from "@/auth.config";
import {getServerEnv, isDevLoginEnabled} from "@/lib/env";
import {connectToDatabase} from "@/lib/db";
import {ensureStaffForEmail, type StaffRole} from "@/lib/models/Staff";

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
    async jwt({token, user}) {
      const email = user?.email ?? token.email;
      if (email) {
        const staff = await ensureStaffForEmail(email, user?.name ?? undefined);
        token.role = staff.role;
        token.staffId = staff.staffId;
      }
      return token;
    },
    async session({session, token}) {
      if (session.user) {
        session.user.role = (token.role as StaffRole | undefined) ?? "staff";
        session.user.staffId = token.staffId as string | undefined;
      }
      return session;
    },
  },
});
