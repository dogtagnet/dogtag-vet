import NextAuth from "next-auth";
import {authConfig} from "@/auth.config";

// Edge-runtime auth gate. Uses the provider-free authConfig only - see src/auth.config.ts for why.
export const {auth: middleware} = NextAuth(authConfig);

export const config = {
  // Run on every route except static assets and Next internals.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
