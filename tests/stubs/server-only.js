// Vitest stub for the `server-only` marker package. Next's own bundler maps this package's
// `react-server` export condition to a no-op (see `server-only`'s package.json) so a real Server
// Component build never pays for the throwing guard; vitest has no such condition configured, so
// without this alias every `import "server-only"` would throw at test-import time even for a file
// that is perfectly safe to unit test directly (e.g. `src/lib/payments/pdf.ts`, which never runs
// in a browser regardless of this marker - `pdfkit` is Node-only and marked
// `serverExternalPackages` in next.config.ts). See vitest.config.ts's alias entry.
export {};
