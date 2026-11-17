import {test as base, expect} from "@playwright/test";

export * from "@playwright/test";
export {expect};

/**
 * The only hosts a page in this suite may contact. Everything else is aborted and fails the test
 * (WP4.21V grade E2: before this guard, every page sent an analytics event to MetaMask's servers
 * from the sign-in page on, and nothing noticed).
 *
 * Add a host here only when the product really needs it, one line with a comment saying what for.
 * Today there is none: the chain reads go to the local RPC stub on 127.0.0.1 and fonts are bundled.
 */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "localhost", // the web server under test
  "127.0.0.1", // the JSON-RPC stub (e2e/rpcStub.ts) and the web server's loopback address
]);

/**
 * Every spec imports `test` and `expect` from this file, never from `@playwright/test` (an eslint
 * rule enforces it). The auto fixture below routes every request of the test's context, so a
 * request to a foreign host is refused before it leaves the machine, and the test fails afterwards
 * naming each host it tried.
 */
export const test = base.extend<{externalHostGuard: void}>({
  externalHostGuard: [
    async ({context}, use) => {
      const attempted: string[] = [];
      await context.route(
        (url) => (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:") && !ALLOWED_HOSTS.has(url.hostname),
        async (route) => {
          attempted.push(route.request().method() + " " + route.request().url());
          await route.abort("blockedbyclient");
        },
      );
      await use();
      expect(attempted, "the page contacted a host outside the allowlist in e2e/fixtures.ts").toEqual([]);
    },
    {auto: true},
  ],
});
