// WP4.18 V7 - a tiny standalone runner for `runPaymentWatcherOnce` (`src/lib/payments/watcher.ts`),
// spawned as a CHILD PROCESS by the ROAX payment e2e spec with explicit env overrides
// (MONGODB_URI -> the e2e Mongo, ROAX_RPC_URL -> the RPC stub, TOKEN_RUSD_ROAX_ADDRESS,
// CONFIRMATIONS_ROAX, PAYMENT_ACTIVITY_CHUNK_BLOCKS_ROAX) - mirroring `e2e/runBootRecovery.ts`
// exactly (see that file's own doc comment for why this runs in a SEPARATE process rather than
// importing watcher.ts straight into the Playwright test's own process: isolation from whatever
// `process.env.MONGODB_URI` happens to be in the shell that launched `pnpm test:e2e`, never the
// live manual-E2E database on 127.0.0.1:27500).
//
// `pnpm dev`'s webServer (playwright.config.ts) never starts the actual worker process
// (`src/worker/index.ts`, a separate `pnpm worker` entry point) - this is why the payment watcher
// has never been exercised by any e2e spec before this wave (plan section 1). This runner calls
// the SAME `runPaymentWatcherOnce` the real worker's `runPaymentWatcherLoop` calls every tick, so
// a passing e2e assertion is proof the production code path pays an invoice, not a parallel one.
import {connectToDatabase} from "../src/lib/db";
import {runPaymentWatcherOnce} from "../src/lib/payments/watcher";

async function main() {
  await connectToDatabase();
  await runPaymentWatcherOnce();
  process.exit(0);
}

main().catch((err) => {
  console.error("[runPaymentWatcher] failed", err);
  process.exit(1);
});
