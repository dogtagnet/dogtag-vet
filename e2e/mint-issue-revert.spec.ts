import {expect, test} from "@playwright/test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";
import {MongoClient} from "mongodb";
import {E2E_MONGO_URI} from "./mongo-fixture";
import {RPC_STUB_URL, resetRpcStub, setRpcReceipt, setRpcScenario} from "./rpcStub";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * End-to-end coverage for plans/wp4.5-track3-mint-plan.md's proven forensic case: `issueTag`'s
 * whole body can succeed on chain and the transaction still revert afterward (an OutOfGas in the
 * clone's gas-refund tail) - the session must flip back to `ready` with a visible error, a
 * subsequent successful attempt must still bind normally, and the worker's boot recovery must heal
 * the exact same case for a session nobody is watching.
 *
 * Sessions are seeded directly into MongoDB (the SAME technique
 * `wallet-registration.spec.ts`'s "expired token" test already uses to force a session into a
 * specific state) rather than by driving the real device-side custodial-bind ceremony through the
 * QR flow - the thing under test here is what happens AFTER a session is already `issuing` with a
 * txHash, not the mint-session-creation flow itself (which has its own coverage elsewhere). The
 * `issueTag` transaction itself is likewise never actually sent through a connected wallet:
 * `confirm`'s reconciliation logic (the thing this suite tests) runs identically no matter what
 * triggers it, so a `page.request.post` standing in for "the browser's own
 * `waitForTransactionReceipt` just resolved" exercises the exact same server-side code a real
 * wagmi write would - the same API-level-trigger convention `wallet-registration.spec.ts` already
 * uses for its own `/complete` calls.
 *
 * DEVIATION (recorded per this track's own instructions): the mint plan's Tests section also asks
 * for "the wizard shows the revert message + re-enabled Issue" and "both-theme screenshots of the
 * revert state" - i.e. driving `TagIssueWizard` itself, not just the API underneath it. That
 * turned out to be UNREACHABLE in this harness: `TagIssueWizard` (like `TagsTable`/
 * `VerifySessionPanel`) renders nothing but a "Connect your operator wallet" banner whenever
 * `useAccount().isConnected` is false (confirmed live via Playwright's own error-context DOM
 * snapshot), and `wagmiConfig` (`src/lib/wagmi.ts`) configures exactly one connector - wagmi's
 * `metaMask()`, backed by the real `@metamask/sdk` (deep-links/QR-pairing/extension-detection, not
 * a thin `window.ethereum` shim a test could satisfy) - with the app's only "Connect" button living
 * in `SetupWizard` and calling `connectors[0]` directly, so there is no simpler connector to reach
 * from a headless browser either. Building a genuine mock wallet connector into production wagmi
 * config to unblock this was evaluated and deliberately deferred (see this track's own advisor
 * consultation): it is production-config risk for a testing-only need, orthogonal to the actual
 * fix under test here, and every test below already proves the fix's real logic (the server-side
 * reconciliation) directly and more precisely than a DOM assertion could. The wizard's own
 * rendering of `lastIssueError`/`attestationSigned` was verified by direct code review instead
 * (`src/app/(app)/tags/issue/TagIssueWizard.tsx`'s `session.lastIssueError`/`session.status ===
 * "ready"` branch), which is the same confidence level `RegistrationFlowEngineTests`-style
 * pure-logic tests give the equivalent iOS UI layer.
 */

const CLONE_ADDRESS = "0x7b9bf16f0e39AdF8c38d8491F4C7E9C17E85D703";
const DOGTAG_SBT_ADDRESS = "0x276101555b2cd92be0fb85ff908e02281d6a3cf9";

async function signInAsStaff(page: import("@playwright/test").Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", {name: "Dev sign in (test only)"}).click();
  await expect(page).toHaveURL(/\/dashboard$/, {timeout: 15_000});
}

async function configureClinic(page: import("@playwright/test").Page) {
  const res = await page.request.patch("/api/settings", {
    data: {cloneAddress: CLONE_ADDRESS, businessProfile: {name: "Example Vet Clinic"}},
  });
  expect(res.ok()).toBe(true);
}

function randomHex(bytes: number): string {
  return "0x" + Array.from({length: bytes * 2}, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

let mongoClient: MongoClient;

test.beforeAll(async () => {
  mongoClient = new MongoClient(E2E_MONGO_URI);
  await mongoClient.connect();
});

test.afterAll(async () => {
  await mongoClient.close();
});

test.beforeEach(async ({page}) => {
  await signInAsStaff(page);
  await configureClinic(page);
  await resetRpcStub();
});

/** Seeds a `MintSession` directly at `status: "issuing"` with a root and txHash already set - the
 * exact shape a session is in the instant the staff wallet's `issueTag` tx was submitted
 * (`POST .../tx`), skipping the device-side QR/custodial-bind ceremony this suite is not testing. */
async function seedIssuingSession(opts: {issuingAt?: Date} = {}): Promise<{sessionId: string; root: string; txHash: string; dogTagIdField: string}> {
  const sessionId = randomUUID();
  const root = randomHex(32);
  const txHash = randomHex(32);
  const dogTagIdField = String(Math.floor(Math.random() * 1_000_000) + 1);
  const now = Math.floor(Date.now() / 1000);
  await mongoClient.db().collection("mintsessions").insertOne({
    sessionId,
    dogTagIdDec: dogTagIdField,
    dogTagIdField,
    ownerIdentity: {},
    identityLeaves: [],
    petName: "Blaze",
    microchip: {},
    profile: {weightHistory: []},
    status: "issuing",
    root,
    txHash,
    protocolVersion: "dogtag-v2/1",
    tokenExp: now + 600,
    issuingAt: opts.issuingAt ?? new Date(),
    createdAt: new Date(),
  });
  return {sessionId, root, txHash, dogTagIdField};
}

test("reverted issueTag receipt: confirm flips the session back to ready with a visible lastIssueError, clears the dead tx, and keeps the audit trail", async ({page}) => {
  const {sessionId, txHash} = await seedIssuingSession();
  await setRpcReceipt(txHash, "reverted");

  const confirmRes = await page.request.post(`/api/tags/issue/${sessionId}/confirm`);
  expect(confirmRes.ok()).toBe(true);
  const confirmBody = await confirmRes.json();
  expect(confirmBody.status).toBe("ready");
  expect(confirmBody.lastIssueError).toMatch(/reverted/i);

  const stored = await mongoClient.db().collection("mintsessions").findOne({sessionId});
  expect(stored?.status).toBe("ready");
  expect(stored?.lastIssueError).toMatch(/reverted/i);
  expect(stored?.failedIssueTxHashes).toEqual([txHash]);
  expect(stored?.txHash).toBeUndefined(); // the dead tx must not linger as if it were still live

  // The poll payload the wizard actually renders from carries the same fields - this is the
  // production GET route (src/app/api/tags/issue/[sessionId]/route.ts), not a re-derivation.
  const pollRes = await page.request.get(`/api/tags/issue/${sessionId}`);
  expect(pollRes.ok()).toBe(true);
  const pollBody = await pollRes.json();
  expect(pollBody.status).toBe("ready");
  expect(pollBody.lastIssueError).toMatch(/reverted/i);
  expect(pollBody.txHash).toBeUndefined();
});

test("retry after a revert: a fresh attempt that confirms successfully clears lastIssueError and binds the tag", async ({page}) => {
  const {sessionId, root, txHash, dogTagIdField} = await seedIssuingSession();
  await setRpcReceipt(txHash, "reverted");
  const firstConfirm = await page.request.post(`/api/tags/issue/${sessionId}/confirm`);
  expect((await firstConfirm.json()).status).toBe("ready");

  // Retry: a fresh issueTag tx that this time actually lands and matches the session's own root.
  const newTxHash = randomHex(32);
  const txRes = await page.request.post(`/api/tags/issue/${sessionId}/tx`, {data: {txHash: newTxHash}});
  expect(txRes.ok()).toBe(true);

  const afterTx = await mongoClient.db().collection("mintsessions").findOne({sessionId});
  expect(afterTx?.status).toBe("issuing");
  expect(afterTx?.lastIssueError).toBeUndefined(); // cleared the instant a fresh attempt starts

  await setRpcReceipt(newTxHash, "success");
  await setRpcScenario("profileRoot", DOGTAG_SBT_ADDRESS, [dogTagIdField], root);
  await setRpcScenario("isValid", CLONE_ADDRESS, [root], true);

  const secondConfirm = await page.request.post(`/api/tags/issue/${sessionId}/confirm`);
  expect(secondConfirm.ok()).toBe(true);
  const secondConfirmBody = await secondConfirm.json();
  expect(secondConfirmBody.status).toBe("bound");
  expect(secondConfirmBody.dogTagId).toBeTruthy();

  const bound = await mongoClient.db().collection("mintsessions").findOne({sessionId});
  expect(bound?.status).toBe("bound");
});

test("worker boot recovery: a stale issuing session whose tx confirmed reverted heals to ready with no tab open", async () => {
  const {txHash, ...seeded} = await seedIssuingSession({issuingAt: new Date(Date.now() - 10 * 60_000)});
  await setRpcReceipt(txHash, "reverted");

  await execFileAsync("npx", ["tsx", "--conditions=react-server", "e2e/runBootRecovery.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MONGODB_URI: E2E_MONGO_URI,
      ROAX_RPC_URL: RPC_STUB_URL,
      ROAX_CHAIN_ID: "135",
      DOGTAG_SBT_ADDRESS,
      VET_ISSUER_FACTORY_ADDRESS: "0x1bd279d3c9fc85eb3e4d304ee890435b6a5ca4cc",
      ENTITY_REGISTRY_ADDRESS: "0x9b15a2df4e38547cbbbd635a4cd4531355bb4247",
      VERIFICATION_REGISTRY_ADDRESS: "0x41e96ad9e93ecb722e69aec6c0d4b4f15040ddd0",
    },
  });

  const healed = await mongoClient.db().collection("mintsessions").findOne({sessionId: seeded.sessionId});
  expect(healed?.status).toBe("ready");
  expect(healed?.lastIssueError).toMatch(/reverted/i);
  expect(healed?.failedIssueTxHashes).toEqual([txHash]);
  expect(healed?.txHash).toBeUndefined();
});

test("worker boot recovery leaves a fresh (non-stale) issuing session alone - a live tab still has time to confirm it itself", async () => {
  const {sessionId, txHash} = await seedIssuingSession({issuingAt: new Date()}); // just now, not stale
  await setRpcReceipt(txHash, "reverted");

  await execFileAsync("npx", ["tsx", "--conditions=react-server", "e2e/runBootRecovery.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MONGODB_URI: E2E_MONGO_URI,
      ROAX_RPC_URL: RPC_STUB_URL,
      ROAX_CHAIN_ID: "135",
      DOGTAG_SBT_ADDRESS,
      VET_ISSUER_FACTORY_ADDRESS: "0x1bd279d3c9fc85eb3e4d304ee890435b6a5ca4cc",
      ENTITY_REGISTRY_ADDRESS: "0x9b15a2df4e38547cbbbd635a4cd4531355bb4247",
      VERIFICATION_REGISTRY_ADDRESS: "0x41e96ad9e93ecb722e69aec6c0d4b4f15040ddd0",
    },
  });

  const untouched = await mongoClient.db().collection("mintsessions").findOne({sessionId});
  expect(untouched?.status).toBe("issuing"); // isMintSessionStale's age guard left it alone
  expect(untouched?.txHash).toBe(txHash);
  expect(untouched?.lastIssueError).toBeUndefined();
});

test("a genuinely PENDING receipt (not yet mined) never takes the revert path - falls through to the pre-existing not-anchored handling untouched", async ({page}) => {
  const {sessionId, txHash} = await seedIssuingSession();
  // Deliberately no setRpcReceipt call - an unscripted txHash answers "not yet mined" (null), and
  // no setRpcScenario calls either - profileRoot/isValid answer their own unscripted defaults
  // (zero root / false), which do not match this session's root. That second, UNRELATED mismatch
  // is what actually drives this test's outcome: the point being verified is narrower than "this
  // session ends up fine" - it's that a merely-pending receipt does NOT get mistaken for a
  // confirmed revert (this same not-anchored/error outcome is exactly what today's PRE-EXISTING
  // logic already does for an issuing session whose chain state simply doesn't match yet, with or
  // without this track's revert-detection change).
  const confirmRes = await page.request.post(`/api/tags/issue/${sessionId}/confirm`);
  expect(confirmRes.status()).toBe(400);
  const confirmBody = await confirmRes.json();
  expect(confirmBody.error?.code).toBe("invalid_input");
  expect(confirmBody.error?.message).toMatch(/did not match/i);

  const stored = await mongoClient.db().collection("mintsessions").findOne({sessionId});
  // The pre-existing not-anchored/error path ran (unrelated to this track) - proving that much is
  // NOT this test's point. What matters: the revert-specific fields are untouched, because the
  // revert branch inside reconcileAnchoredSession was never entered for a merely-pending receipt.
  expect(stored?.status).toBe("error");
  expect(stored?.errorStage).toBe("verify");
  expect(stored?.txHash).toBe(txHash); // still the live tx - never cleared as if it were dead
  expect(stored?.lastIssueError).toBeUndefined();
  expect(stored?.failedIssueTxHashes).toBeUndefined();
});

test("a receipt that reads back SUCCESS but still does not anchor stays on the existing error path, never the gentler revert-to-ready one", async ({page}) => {
  const {sessionId, txHash} = await seedIssuingSession();
  // The tx mined successfully, but (unscripted) profileRoot/isValid still disagree with this
  // session's root - a genuinely alarming state (wp4.5-track3-mint-plan.md's own distinction:
  // only a CONFIRMED revert earns the gentler ready+lastIssueError treatment).
  await setRpcReceipt(txHash, "success");

  const confirmRes = await page.request.post(`/api/tags/issue/${sessionId}/confirm`);
  expect(confirmRes.status()).toBe(400);

  const stored = await mongoClient.db().collection("mintsessions").findOne({sessionId});
  expect(stored?.status).toBe("error");
  expect(stored?.errorStage).toBe("verify");
  expect(stored?.lastIssueError).toBeUndefined();
  expect(stored?.failedIssueTxHashes).toBeUndefined();
});

/**
 * WP4.5 track 3's OTHER live-hot-fixed UI bug (commit 2eb9e51): the bound-state "Sign issuer
 * attestation" button flipped to a done badge via LOCAL React state only, which reverted to
 * offering the button again on a reload even though the attestation was genuinely already stored -
 * fixed by deriving `attestationSigned` from the poll payload (GET .../[sessionId]/route.ts reads
 * `Pet.dogTag.attestation` directly), not a `useState` that starts false on every mount. This test
 * writes `dogTag.attestation` directly (the field the real POST .../attestation route also writes -
 * unchanged by this track, so faking its end state here tests exactly the NEW poll-derivation logic
 * without re-proving the pre-existing signature-verification write path) and confirms the poll
 * payload flips from false to true - the same payload the wizard re-fetches on every page load,
 * including after a reload.
 */
test("attestation-signed state survives a reload: the poll reports attestationSigned from the linked Pet's own record, not a client-local flag", async ({page}) => {
  const petId = randomUUID();
  await mongoClient.db().collection("pets").insertOne({
    petId,
    name: "Blaze",
    microchip: {},
    weightHistory: [],
    ownerClientIds: [],
    dogTag: {},
    searchKey: "blaze",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const sessionId = randomUUID();
  const root = randomHex(32);
  const dogTagIdField = String(Math.floor(Math.random() * 1_000_000) + 1);
  await mongoClient.db().collection("mintsessions").insertOne({
    sessionId,
    dogTagIdDec: dogTagIdField,
    dogTagIdField,
    ownerIdentity: {},
    identityLeaves: [],
    petId,
    petName: "Blaze",
    microchip: {},
    profile: {weightHistory: []},
    status: "bound",
    root,
    protocolVersion: "dogtag-v2/1",
    tokenExp: Math.floor(Date.now() / 1000) + 600,
    createdAt: new Date(),
    resolvedAt: new Date(),
  });

  const before = await page.request.get(`/api/tags/issue/${sessionId}`);
  expect(before.ok()).toBe(true);
  expect((await before.json()).attestationSigned).toBeFalsy();

  // Simulates what a real POST .../attestation success already writes (unchanged by this track) -
  // this test's own concern is only whether the POLL notices it, not how it got there.
  await mongoClient.db().collection("pets").updateOne(
    {petId},
    {
      $set: {
        "dogTag.attestation": {
          domain: {name: "DogTagIssuerAttestation", version: "1", chainId: 135, verifyingContract: CLONE_ADDRESS},
          message: {merkleRoot: root, recordType: `0x${"11".repeat(32)}`, issuerContract: CLONE_ADDRESS, issuerName: "Example Vet Clinic", issuerDomain: "example-vet.test"},
          signature: `0x${"22".repeat(65)}`,
          issuerSigner: "0x1111111111111111111111111111111111111111",
        },
      },
    },
  );

  // The SAME poll a page reload re-runs - no server restart, no cache to bust, just a fresh GET.
  const after = await page.request.get(`/api/tags/issue/${sessionId}`);
  expect(after.ok()).toBe(true);
  expect((await after.json()).attestationSigned).toBe(true);
});
