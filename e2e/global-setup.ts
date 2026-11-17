import type {FullConfig} from "@playwright/test";
import {seedTestMongo, startTestMongo} from "./mongo-fixture";
import {startRpcStub} from "./rpcStub";

/**
 * Placeholder for every dynamic segment below. Next dev compiles a dynamic route's whole module
 * graph for any request matching the segment shape, before the handler ever looks the id up, so a
 * value that resolves to nothing (a 404, 400 or 401 answer) still pays the compile. No GET here
 * has a side effect.
 */
const X = "warm-up-placeholder";

/**
 * Staff-only PAGES and APIs sit behind `src/middleware.ts` (`auth.config.ts`'s `authorized`), so an
 * anonymous request is redirected or refused before the route module is ever compiled. They are
 * warmed with a real dev-login session instead (see `signInForWarmUp`). The email is the one every
 * spec signs in as first, so the Staff row this creates is the same owner row the first spec would
 * have created anyway.
 */
const WARM_UP_EMAIL = "owner@example.com";

/**
 * Public routes (no session needed): `auth.config.ts`'s publicPrefixes and exact paths.
 */
const WARM_UP_PUBLIC_ROUTES = [
  "/",
  "/sign-in",
  "/book",
  "/v1/entity",
  "/v1/booking/services",
  "/v1/booking/availability",
  "/v1/booking/book",
  `/v1/booking/appointments/${X}`,
  `/v1/booking/appointments/${X}/cancel`,
  `/v1/payments/${X}/public`,
  `/w/${X}`,
  `/w/${X}/complete`,
  `/d/${X}`,
  `/d/${X}/complete`,
  `/d/${X}/status`,
  `/i/${X}`,
  `/i/${X}/complete`,
  `/p/${X}`,
  `/p/${X}/status`,
  `/v/${X}`,
  `/v/${X}/complete`,
  `/e/${X}`,
];

/**
 * Staff-only page routes: every `page.goto(...)` target across e2e/*.spec.ts (and /dashboard, where
 * every spec's devLogin lands), with `${id}` segments replaced by the placeholder.
 */
const WARM_UP_STAFF_PAGES = [
  "/dashboard",
  "/settings",
  "/tags",
  "/tags/issue",
  "/calendar",
  "/appointments",
  `/appointments/${X}`,
  `/clients/${X}`,
  `/pets/${X}`,
  "/pets/new",
  `/payments/${X}`,
  "/services",
  "/services/new",
  "/verify",
  "/verify/records",
  "/verify/redacted",
];

/**
 * Staff-only API routes: every `request.*(...)` call across e2e/*.spec.ts plus every route the
 * pages above call from the browser (grep of `fetch(` under src/), so the flows behind them (tag
 * export and masked export, the wallet card, wallet registration, record verify, delegations) do
 * not compile inside a test's own assertion clock. A 4xx or 405 answer is fine.
 */
const WARM_UP_STAFF_APIS = [
  "/api/appointments",
  `/api/appointments/${X}`,
  `/api/appointments/${X}/relink-dogtag`,
  "/api/appointments/from-local-time",
  "/api/availability/rules",
  `/api/availability/rules/${X}`,
  "/api/availability/settings",
  "/api/availability/exceptions",
  `/api/availability/exceptions/${X}`,
  "/api/clients",
  `/api/clients/${X}`,
  `/api/clients/${X}/wallet-registrations`,
  `/api/clients/${X}/wallet-registrations/${X}`,
  `/api/clients/${X}/wallets/${X}`,
  `/api/clients/${X}/wallets/${X}/revoke`,
  "/api/ics-feed-token",
  "/api/payments",
  "/api/payments/rails",
  `/api/payments/${X}/cancel`,
  `/api/payments/${X}/email`,
  `/api/payments/${X}/mark-paid`,
  "/api/pets",
  `/api/pets/${X}`,
  `/api/pets/${X}/photo`,
  `/api/pets/${X}/records`,
  `/api/pets/${X}/export-tag-data`,
  `/api/pets/${X}/export-tag-data/fields`,
  `/api/pets/${X}/export-tag-data/preview`,
  `/api/pets/${X}/records/${X}/export`,
  `/api/pets/${X}/records/${X}/export/fields`,
  `/api/pets/${X}/records/${X}/export/preview`,
  `/api/pets/${X}/delegations`,
  `/api/pets/${X}/delegations/${X}`,
  `/api/pets/${X}/delegations/${X}/tx`,
  `/api/pets/${X}/delegations/${X}/confirm`,
  `/api/records/${X}/attestation`,
  `/api/records/${X}/confirm`,
  `/api/records/${X}/lifecycle`,
  `/api/records/${X}/tx`,
  "/api/services",
  `/api/services/${X}`,
  "/api/settings",
  "/api/settings/staff",
  `/api/settings/staff/${X}`,
  "/api/settings/staff/me/profile",
  "/api/settings/staff/me/wallet",
  "/api/tags",
  `/api/tags/${X}/lifecycle`,
  "/api/tags/import-sessions",
  "/api/tags/issue/start",
  `/api/tags/issue/${X}`,
  `/api/tags/issue/${X}/attestation`,
  `/api/tags/issue/${X}/confirm`,
  `/api/tags/issue/${X}/retry`,
  `/api/tags/issue/${X}/tx`,
  "/api/tags/revoke-superseded",
  "/api/verify/start",
  `/api/verify/${X}`,
  `/api/verify/${X}/recorded`,
  "/api/verify/records/start",
  `/api/verify/records/${X}`,
  "/api/verify/redacted-artifact",
  `/api/files/${X}`,
];

/**
 * Root cause this fixes (WP4.21V grade D2): playwright.config.ts's webServer resolves as soon as the
 * dev server's port answers, but `next dev` compiles every page and API route lazily on its own
 * first request. Whichever spec first touched a cold route paid the compile inside its own
 * assertion clock, so a loaded machine failed a different set of tests on every run, each of which
 * passed alone. Warming every route here, before the first test starts, moves that cost out of
 * the tests. Modelled on dogtag-admin/e2e/global-setup.ts.
 */
const WARM_UP_TIMEOUT_MS = 60_000;

async function warmUpRoute(baseURL: string, route: string, cookie: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WARM_UP_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${baseURL}${route}`, {signal: controller.signal, redirect: "manual", headers: cookie ? {cookie} : {}});
    await res.arrayBuffer().catch(() => undefined);
    console.log(`[global-setup] warmed ${route} -> ${res.status} (${Date.now() - startedAt}ms)`);
  } catch (error) {
    // A timeout here is logged and ignored: the real tests hit the route again and report a real failure.
    console.warn(`[global-setup] warm-up fetch for ${route} did not complete (${Date.now() - startedAt}ms): ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Cookie jar update: Auth.js can set the same cookie twice in one reply (the last one wins). */
function mergeCookies(jar: Map<string, string>, res: Response): void {
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * The same sequence the sign-in form's `signIn("dev-login")` runs, over plain HTTP: csrf token,
 * then the credentials callback. Returns the session cookie header ("" if sign-in did not work, in
 * which case the staff routes below only warm their redirect and the tests surface any real failure).
 */
async function signInForWarmUp(baseURL: string): Promise<string> {
  try {
    const csrfRes = await fetch(`${baseURL}/api/auth/csrf`);
    const {csrfToken} = (await csrfRes.json()) as {csrfToken: string};
    const jar = new Map<string, string>();
    mergeCookies(jar, csrfRes);
    const res = await fetch(`${baseURL}/api/auth/callback/dev-login`, {
      method: "POST",
      redirect: "manual",
      headers: {"content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(jar)},
      body: new URLSearchParams({csrfToken, email: WARM_UP_EMAIL, json: "true"}),
    });
    await res.arrayBuffer().catch(() => undefined);
    mergeCookies(jar, res);
    console.log(`[global-setup] warm-up dev-login -> ${res.status} location=${res.headers.get("location")}`);
    return cookieHeader(jar);
  } catch (error) {
    console.warn(`[global-setup] warm-up dev-login failed: ${String(error)}`);
    return "";
  }
}

export default async function globalSetup(config: FullConfig) {
  await startTestMongo();
  await seedTestMongo();
  // Listens for the whole run - `playwright.config.ts` points the web server's ROAX_RPC_URL at
  // it, so every test (not just WP4.4's own) gets a deterministic, offline chain instead of the
  // real devnet RPC. `global-teardown.ts` closes it explicitly.
  startRpcStub();

  // Read from the resolved config (not a literal) so a scratchpad copy on other ports warms the right server.
  // The warm-up is only for `next dev` (E2E_DEV=1): the default production build has no compile step.
  if (process.env.E2E_DEV !== "1") return;
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("global-setup: no projects[0].use.baseURL configured - cannot warm up routes.");

  // The auth catch-all first (session, csrf, callback are one compiled module), then public
  // routes, then staff routes with a real session.
  await warmUpRoute(baseURL, "/api/auth/session", "");
  for (const route of WARM_UP_PUBLIC_ROUTES) await warmUpRoute(baseURL, route, "");
  const cookie = await signInForWarmUp(baseURL);
  for (const route of [...WARM_UP_STAFF_PAGES, ...WARM_UP_STAFF_APIS]) await warmUpRoute(baseURL, route, cookie);
}
