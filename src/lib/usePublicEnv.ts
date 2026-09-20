"use client";

import {useSyncExternalStore} from "react";
import {publicEnv, publicEnvServerFallback, type PublicEnv} from "@/lib/env.public";

/**
 * Split out of `env.public.ts` itself (rather than exporting this hook alongside `publicEnv`
 * there) so that file stays import-safe from server route handlers too - `chains.ts`'s `roax`
 * chain object (built from `publicEnv`) is used for server-side chain reads as well as client
 * ones, and Next.js refuses to build ANY file that imports a React hook unless it (or an ancestor)
 * is marked `"use client"`, even if the hook is never actually called along a given server-side
 * import path.
 */

function subscribeNever() {
  // The runtime-injected fields `publicEnv` reads are set ONCE, from a `beforeInteractive` script
  // that has always already run by the time any React code executes - there is no later moment
  // within a page's lifetime this value could change, so there is nothing to subscribe to.
  return () => {};
}

/**
 * `publicEnv`, but safe to read WHILE RENDERING a component whose OUTPUT SHAPE (not merely a
 * network-call argument or an href) branches on one of the runtime-injected fields - e.g.
 * SetupWizard's "Protocol addresses are not configured" banner, which exists only when
 * `vetIssuerFactoryAddress` is empty.
 *
 * Reading the module-scope `publicEnv` constant directly for that purpose is unsafe: this Next.js
 * server process never has `window` (Node.js has no such global), so EVERY server-side render of
 * that component produces the build-time-fallback branch, while the CLIENT's own module-scope
 * `publicEnv` is already the true injected value by the time any client component first runs (the
 * injection script, in the document `<head>`, always executes first) - a real React hydration
 * error (mismatched DOM shape), not a false alarm, the first time a real deployment's build-time
 * value differs from its runtime one - the exact scenario this runtime-config feature exists for.
 *
 * `useSyncExternalStore`'s third argument exists for precisely this: React uses it for the
 * CLIENT's first (hydrating) render too, so that render matches what the server actually sent,
 * then immediately re-renders with the real (`getSnapshot`) value once mounted - no hydration
 * error, no discarded subtree. See
 * https://react.dev/reference/react/useSyncExternalStore#adding-support-for-server-rendering.
 */
export function usePublicEnv(): PublicEnv {
  return useSyncExternalStore(subscribeNever, () => publicEnv, () => publicEnvServerFallback);
}
