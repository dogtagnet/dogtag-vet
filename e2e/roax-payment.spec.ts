import {expect, test, type Page} from "@playwright/test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {randomBytes} from "node:crypto";
import {E2E_MONGO_URI} from "./mongo-fixture";
import {RPC_STUB_URL, getCurrentBlockNumber, resetRpcStub, setRpcErc20Transfer, setRpcNativeTransfer} from "./rpcStub";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * WP4.18 V7 - a ROAX invoice from creation to confirmed, against the rpc stub, covering both of
 * ROAX's assets: PLASMA (native) and RUSD (ERC-20). This is the first e2e coverage the payment
 * path has ever had (plan section 1: "MANUAL-E2E Parts 0 to 17 contain no payment step; the vet
 * worker's payment watcher was started but never exercised").
 *
 * Every authenticated call goes through `page.request` (shares the signed-in browser context's
 * session cookie), never the standalone `request` fixture (its own separate, cookie-less
 * APIRequestContext) - the established convention every other spec in this repo already follows
 * (mint-issue-revert.spec.ts's own doc comment: "a page.request.post standing in for..."); using
 * the standalone fixture here first (an easy mistake, since both fixtures expose the identical
 * `.get`/`.post`/`.patch` API) surfaced as `POST /api/payments` silently 200-ing with a sign-in
 * HTML page instead of a session error, caught by `createRes.json()` throwing on non-JSON body
 * rather than by the `.ok()` check, which was genuinely misleading until traced back to the
 * fixture mismatch.
 *
 * `pnpm dev`'s webServer (playwright.config.ts) never starts the actual worker process, so the
 * payment watcher is driven directly via `e2e/runPaymentWatcher.ts`, spawned as a child process
 * exactly like `e2e/runBootRecovery.ts` already is by mint-issue-revert.spec.ts - same isolation
 * rationale (own MONGODB_URI/ROAX_RPC_URL, never the live manual-E2E database).
 *
 * TWO ticks, not one: CONFIRMATIONS_ROAX stays at its shipped default (2), deliberately not
 * lowered for this test. Derivation: call it C for the block number `getCurrentBlockNumber` (a
 * control-plane read that does NOT advance the stub's counter, unlike a real `eth_blockNumber`
 * call) returns right before scripting a transfer at block C+1. Tick 1's own `scanChain` makes
 * its first (and only) `eth_blockNumber` call, advancing the counter to C+1 - the transfer, at
 * block C+1, has confirmations = (C+1) - (C+1) + 1 = 1, short of 2, so it is observed but not yet
 * matched; the cursor persists at C-1 (latest - confirmations). Tick 2's own `eth_blockNumber`
 * call advances the counter again, to C+2; fromBlock resumes at C (cursor+1), the scanned range
 * [C, C+2] re-includes block C+1, and this time confirmations = (C+2) - (C+1) + 1 = 2, meeting the
 * threshold exactly - matched. Two ticks, deterministically, every run.
 */

const RECEIVING = "0x" + "aa".repeat(20);
const SENDER = "0x" + "cc".repeat(20);

function fakeTxHash(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

async function signInAsStaff(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", {name: "Dev sign in (test only)"}).click();
  await expect(page).toHaveURL(/\/dashboard$/, {timeout: 15_000});
}

async function runPaymentWatcherTick(): Promise<void> {
  await execFileAsync("npx", ["tsx", "--conditions=react-server", "e2e/runPaymentWatcher.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MONGODB_URI: E2E_MONGO_URI,
      ROAX_RPC_URL: RPC_STUB_URL,
      ROAX_CHAIN_ID: "135",
      CONFIRMATIONS_ROAX: "2",
      PAYMENT_ACTIVITY_CHUNK_BLOCKS_ROAX: "200",
    },
  });
}

test.beforeEach(async () => {
  await resetRpcStub();
});

test("a ROAX PLASMA invoice: created, paid via a scripted native transfer, and confirmed", async ({page}) => {
  test.setTimeout(90_000);
  await signInAsStaff(page);

  const settingsRes = await page.request.patch("/api/settings", {data: {receivingAddresses: [{chainKey: "roax", address: RECEIVING}]}});
  expect(settingsRes.ok()).toBeTruthy();

  const createRes = await page.request.post("/api/payments", {
    data: {
      lineItems: [{description: "Annual checkup", qty: 1, unitAmount: "75.00"}],
      currency: "USD",
      acceptedRails: [{chainKey: "roax", token: "PLASMA", manualRate: "2500.00"}],
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const payment = await createRes.json();
  expect(payment.crypto).toHaveLength(1);
  const rail = payment.crypto[0];
  expect(rail.chainKey).toBe("roax");
  expect(rail.token).toBe("PLASMA");
  expect(rail.receivingAddress.toLowerCase()).toBe(RECEIVING);

  // Public status before payment: pending, with the PLASMA rail described exactly (V6).
  const beforeRes = await page.request.get(`/v1/payments/${payment.paymentId}/public?token=${payment.viewToken}`);
  const before = await beforeRes.json();
  expect(before.status).toBe("pending");
  expect(before.rails).toEqual([
    {
      tokenSymbol: "PLASMA",
      tokenAmount: expect.any(String),
      chainId: 135,
      receivingAddress: rail.receivingAddress,
      eip681: rail.eip681,
    },
  ]);

  // Script the EXACT transfer (never hand-computed) into the block right after the first tick's
  // own `eth_blockNumber` call - see this file's own doc comment for the two-tick derivation.
  const beforeBlock = await getCurrentBlockNumber();
  const txHash = fakeTxHash();
  await setRpcNativeTransfer({blockNumber: beforeBlock + 1n, to: rail.receivingAddress, from: SENDER, value: rail.amountBase, hash: txHash});

  await runPaymentWatcherTick(); // tick 1: observes the transfer at 1 confirmation, not yet enough
  await runPaymentWatcherTick(); // tick 2: re-scans the same block, now at 2 confirmations - matches

  const afterRes = await page.request.get(`/v1/payments/${payment.paymentId}/public?token=${payment.viewToken}`);
  const after = await afterRes.json();
  expect(after.status).toBe("paid");
  expect(after.chain).toBe("roax");
  expect(after.chainId).toBe(135);
  expect(after.txHash).toBe(txHash);
  expect(after.rails).toBeUndefined(); // nothing left to pay once settled

  // Confirmed on the staff side too - a fresh navigation reads the same durable DB state.
  await page.goto(`/payments/${payment.paymentId}`);
  await expect(page.getByText("Paid", {exact: true})).toBeVisible();
});

test("a ROAX RUSD invoice: created, paid via a scripted Transfer log, and confirmed", async ({page}) => {
  test.setTimeout(90_000);
  await signInAsStaff(page);

  const settingsRes = await page.request.patch("/api/settings", {data: {receivingAddresses: [{chainKey: "roax", address: RECEIVING}]}});
  expect(settingsRes.ok()).toBeTruthy();

  const createRes = await page.request.post("/api/payments", {
    data: {
      lineItems: [{description: "Vaccination", qty: 1, unitAmount: "75.00"}],
      currency: "USD",
      acceptedRails: [{chainKey: "roax", token: "RUSD", manualRate: "1.00"}],
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const payment = await createRes.json();
  expect(payment.crypto).toHaveLength(1);
  const rail = payment.crypto[0];
  expect(rail.token).toBe("RUSD");
  expect(rail.tokenAddress).toBeTruthy(); // the default placeholder address is still a real address shape

  const beforeBlock = await getCurrentBlockNumber();
  const txHash = fakeTxHash();
  await setRpcErc20Transfer({
    address: rail.tokenAddress,
    blockNumber: beforeBlock + 1n,
    from: SENDER,
    to: rail.receivingAddress,
    value: rail.amountBase,
    hash: txHash,
  });

  await runPaymentWatcherTick();
  await runPaymentWatcherTick();

  const afterRes = await page.request.get(`/v1/payments/${payment.paymentId}/public?token=${payment.viewToken}`);
  const after = await afterRes.json();
  expect(after.status).toBe("paid");
  expect(after.txHash).toBe(txHash);

  await page.goto(`/payments/${payment.paymentId}`);
  await expect(page.getByText("Paid", {exact: true})).toBeVisible();
  await expect(page.getByText("RUSD", {exact: true}).first()).toBeVisible();
});

test("a SHORT native transfer never confirms the invoice, even after two watcher ticks", async ({page}) => {
  test.setTimeout(90_000);
  await signInAsStaff(page);
  await page.request.patch("/api/settings", {data: {receivingAddresses: [{chainKey: "roax", address: RECEIVING}]}});

  const createRes = await page.request.post("/api/payments", {
    data: {
      lineItems: [{description: "Checkup", qty: 1, unitAmount: "75.00"}],
      currency: "USD",
      acceptedRails: [{chainKey: "roax", token: "PLASMA", manualRate: "2500.00"}],
    },
  });
  const payment = await createRes.json();
  const rail = payment.crypto[0];
  const shortValue = (BigInt(rail.amountBase) - 1n).toString(); // one base unit short of the exact amount owed

  const beforeBlock = await getCurrentBlockNumber();
  await setRpcNativeTransfer({blockNumber: beforeBlock + 1n, to: rail.receivingAddress, from: SENDER, value: shortValue, hash: fakeTxHash()});

  await runPaymentWatcherTick();
  await runPaymentWatcherTick();

  const afterRes = await page.request.get(`/v1/payments/${payment.paymentId}/public?token=${payment.viewToken}`);
  const after = await afterRes.json();
  expect(after.status).toBe("pending"); // still unpaid - a short transfer is never treated as payment in full
});
