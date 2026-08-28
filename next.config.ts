import type {NextConfig} from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // The vendored protocol/packages/dogtag-standard-ts workspace package ships its own
  // pnpm-lock.yaml, which would otherwise make Next.js guess at the monorepo root. Pin it
  // explicitly to this repo's root.
  outputFileTracingRoot: path.join(__dirname),
  // The vendored @dogtag/standard package pulls in circomlibjs / poseidon-lite for Merkle and
  // field-element crypto. That code must only ever run on the server (mint-session verification,
  // dogTagIdField derivation) - never bundled into a client component. Marking it external keeps
  // it out of the client bundle and lets Next require() it directly on the server at runtime.
  // pdfkit loads its .afm font-metrics files from disk at runtime (not bundle time) - left
  // un-externalized, Next's bundler would inline it and that file lookup would fail against the
  // bundled output path instead of pdfkit's real package directory, breaking PDF generation at
  // request time with `pnpm build` still green. See src/lib/payments/pdf.ts and
  // tests/unit/pdf.test.ts (which asserts a real PDF actually comes out, not just that the build
  // succeeds).
  serverExternalPackages: ["@dogtag/standard", "circomlibjs", "poseidon-lite", "pdfkit"],
  // IMPORTANT for anyone touching the Docker build: `next build`'s standalone-output tracer
  // (@vercel/nft) cannot fully resolve `@dogtag/standard` at runtime. It is ESM-only
  // (`"type": "module"`, `exports["."]` has only an `import` condition, no `require`), so the
  // tracer's CJS-require resolution against that map comes up empty - it copies only the
  // package's `package.json` into `.next/standalone/`, none of `dist/`, and consequently never
  // walks into its own dependencies (`circomlibjs` -> `ethers`, `ffjavascript`, `blake-hash`,
  // `blake2b`; `poseidon-lite`). `circomlibjs` is imported at the top of `consent.js`, which
  // `index.js` re-exports unconditionally, so this is not a narrow feature gap - it breaks
  // `import` of `@dogtag/standard` at all, i.e. every mint and verify route.
  //
  // This was found by actually inspecting `.next/standalone/` after a real build (empty `dist/`,
  // no `circomlibjs` anywhere) - a green `pnpm build` gives no signal of it, since dev and
  // `next start` both run against the full `node_modules`, never the standalone tree.
  //
  // Rather than force-including this dependency graph file-by-file here (`ethers` alone pulls in
  // enough of its own transitive tree that hand-maintaining the list would be its own ongoing
  // source of bugs), the fix lives in `Dockerfile`: the runner stage copies the complete, really-
  // `pnpm install`-resolved `node_modules` and `protocol/` over the standalone tracer's output,
  // rather than trusting the trace for these two directories. See that file's comment.
  //
  // `pdfkit` does not have this problem (it is a normal CJS package and its own JS traces fine)
  // except for its `.afm` font-metrics files, which it loads by constructing a filename from a
  // font name at runtime - the tracer's static analysis cannot follow that, so those particular
  // data files are force-included below. This one stays here rather than moving to the Dockerfile
  // fix because it is genuinely narrow (a handful of known data files in one package) and it also
  // fixes deployments that use `.next/standalone` directly, outside Docker.
  outputFileTracingIncludes: {
    "/**": ["./node_modules/pdfkit/**/*"],
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  webpack: (config) => {
    // src/lib/wagmi.ts wires only the MetaMask connector, but `wagmi/connectors` is a single
    // barrel export - webpack still has to resolve every connector reachable from it, including
    // the Coinbase "baseAccount" connector's optional x402 payment code path. Those `@x402/*`
    // subpath imports are peer-optional in @coinbase/cdp-sdk and this app never exercises that
    // path (no Coinbase/base-account connector is registered), so alias them out instead of
    // pulling in an unrelated payments SDK this app has no use for.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/core/client": false,
      "@x402/evm/exact/client": false,
      "@x402/svm/exact/client": false,
      "@x402/evm": false,
    };
    return config;
  },
};

export default nextConfig;
