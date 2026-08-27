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
