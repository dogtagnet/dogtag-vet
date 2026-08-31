import {describe, expect, it} from "vitest";
import {authConfig} from "@/auth.config";

/**
 * `src/middleware.ts` gates every route except `authConfig`'s own public-path allowlist behind
 * staff sign-in. `GET /w/:token` and `POST /w/:token/complete` are the owner-facing wallet-
 * registration public routes (plans/wp4.2-client-wallet-registration.md) and must never require a
 * staff session - forgetting to add `/w/` here would make every mobile scan redirect to sign-in
 * instead of 200ing (or 404/410ing) for an unauthenticated caller.
 */
function isAuthorized(pathname: string): boolean {
  const request = {nextUrl: new URL(`https://vet.example.com${pathname}`)} as Parameters<
    NonNullable<typeof authConfig.callbacks.authorized>
  >[0]["request"];
  const result = authConfig.callbacks.authorized!({auth: null, request} as Parameters<NonNullable<typeof authConfig.callbacks.authorized>>[0]);
  if (typeof result !== "boolean") throw new Error("expected a synchronous boolean from authorized()");
  return result;
}

describe("auth.config's public-route allowlist", () => {
  it("allows the wallet-registration challenge route with no session", () => {
    expect(isAuthorized("/w/0123456789abcdef0123456789abcdef")).toBe(true);
  });

  it("allows the wallet-registration complete route with no session", () => {
    expect(isAuthorized("/w/0123456789abcdef0123456789abcdef/complete")).toBe(true);
  });

  it("still requires a session for the staff wallet-registration API routes (not /w/, but /api/clients/...)", () => {
    expect(isAuthorized("/api/clients/some-client-id/wallet-registrations")).toBe(false);
  });

  it("still requires a session for ordinary staff pages", () => {
    expect(isAuthorized("/clients/some-client-id")).toBe(false);
    expect(isAuthorized("/dashboard")).toBe(false);
  });

  it("does not accidentally make an unrelated /w-prefixed path public via a loose startsWith match on a bare word", () => {
    // Guards against a future `/webhooks` or similar landing inside the SAME "/w/" prefix check by
    // accident - `/w/` (with trailing slash) only ever matches an actual token path.
    expect(isAuthorized("/webhooks/something")).toBe(false);
  });

  it("still allows the pre-existing public routes (regression guard against this edit breaking the array)", () => {
    expect(isAuthorized("/p/0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isAuthorized("/x/0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isAuthorized("/sign-in")).toBe(true);
  });
});
