// WP4.5 track 3 - a tiny standalone runner for `recoverInterruptedSessions` (`src/lib/mint/
// bootRecovery.ts`), spawned as a CHILD PROCESS by `mint-issue-revert.spec.ts` with explicit env
// overrides (MONGODB_URI -> the e2e Mongo, ROAX_RPC_URL -> the RPC stub, the protocol addresses ->
// the same fixture addresses `playwright.config.ts`'s webServer.env uses) - mirroring
// `e2e/mongo-fixture.ts`'s `seedTestMongo()`, which spawns `pnpm run seed` the same way. Doing this
// in a SEPARATE process (not by importing `bootRecovery.ts` straight into the Playwright test's own
// process) means it only ever touches Mongo/RPC endpoints this file explicitly sets, never whatever
// `process.env.MONGODB_URI` happens to be in the shell that launched `pnpm test:e2e` - see this
// track's isolation rule (never the live manual-E2E database on 127.0.0.1:27500).
import {connectToDatabase} from "../src/lib/db";
import {recoverInterruptedSessions} from "../src/lib/mint/bootRecovery";

async function main() {
  await connectToDatabase();
  await recoverInterruptedSessions();
  process.exit(0);
}

main().catch((err) => {
  console.error("[runBootRecovery] failed", err);
  process.exit(1);
});
