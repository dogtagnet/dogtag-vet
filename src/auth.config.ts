import type {NextAuthConfig} from "next-auth";

/**
 * Edge-safe half of the Auth.js config: no providers, no database adapter, nothing that touches
 * mongoose or Node-only APIs. This is what src/middleware.ts runs on every request (the Edge
 * runtime) to gate the staff app shell; the full config with providers lives in src/auth.ts and
 * only ever runs in the Node runtime (route handlers, server components).
 */
export const authConfig = {
  pages: {
    signIn: "/sign-in",
  },
  session: {
    strategy: "jwt",
  },
  // The real provider list is assembled in src/auth.ts (it depends on env + Node-only crypto);
  // this Edge-safe half only needs a value here to satisfy NextAuthConfig's shape.
  providers: [],
  callbacks: {
    authorized({auth, request}) {
      const isLoggedIn = Boolean(auth?.user);
      const {pathname} = request.nextUrl;
      // Everything is staff-only (behind sign-in) except the marketing/auth surface and the
      // protocol-mandated public routes (mint/verify resolve, booking, payment status, receipts -
      // specs/vet-public-api.yaml) - those never carry staff credentials by design.
      const publicPrefixes = ["/sign-in", "/design", "/api/auth", "/p/", "/x/", "/v1/", "/r/"];
      const isPublic = pathname === "/" || publicPrefixes.some((p) => pathname.startsWith(p));
      if (isPublic) return true;
      return isLoggedIn;
    },
  },
} satisfies NextAuthConfig;
