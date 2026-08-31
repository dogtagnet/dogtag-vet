import {seedTestMongo, startTestMongo} from "./mongo-fixture";
import {startRpcStub} from "./rpcStub";

export default async function globalSetup() {
  await startTestMongo();
  await seedTestMongo();
  // Listens for the whole run - `playwright.config.ts` points the web server's ROAX_RPC_URL at
  // it, so every test (not just WP4.4's own) gets a deterministic, offline chain instead of the
  // real devnet RPC. `global-teardown.ts` closes it explicitly.
  startRpcStub();
}
