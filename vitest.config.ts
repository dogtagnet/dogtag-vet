import {defineConfig} from "vitest/config";
import path from "node:path";

/**
 * Scoped to this app's own unit tests only. The vendored `protocol/packages/dogtag-standard-ts`
 * ships its own vitest suite (and its own test fixtures, some of which are only present in the
 * full protocol monorepo this snapshot was vendored from) - without this `include`, vitest's
 * default workspace-wide discovery would also pick up those vendored tests and fail on missing
 * fixtures that have nothing to do with dogtag-vet. Run the protocol package's own tests via
 * `pnpm --filter @dogtag/standard test` if you need to re-verify the vendored library itself.
 */
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Next maps `server-only` to a no-op under its own `react-server` build condition; vitest
      // has no such condition, so alias it to an equivalent no-op stub here too - see
      // tests/stubs/server-only.js for the full rationale.
      "server-only": path.resolve(__dirname, "./tests/stubs/server-only.js"),
    },
  },
});
