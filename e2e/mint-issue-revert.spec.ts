import {expect, test, type Page} from "@playwright/test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {randomBytes, randomUUID} from "node:crypto";
import {MongoClient} from "mongodb";
import {E2E_MONGO_URI} from "./mongo-fixture";
import {RPC_STUB_URL, getLastSendTransaction, resetRpcStub, setRpcGasEstimate, setRpcReceipt, setRpcScenario} from "./rpcStub";

// Same scratchpad directory calendar-services.spec.ts/booking-config-timezone.spec.ts/others
// already write their own both-theme screenshots into - one shared, obviously-scratch location
// rather than each spec inventing its own.
const SHOTS_DIR = "/private/tmp/claude-501/-Users-zhenhaowu-code-dogtag/85e989bd-eec1-4250-ab09-83fb3244d856/scratchpad/wp45-shots";

/** The exact revert message `markSessionRevertedReady` (src/lib/mint/reconcile.ts) persists as
 * `lastIssueError` - reconcile.ts is `import "server-only"`, so it cannot be imported from a spec
 * file Playwright itself loads (no `react-server` condition here, unlike this file's own
 * `runBootRecovery` subprocess below); duplicated as a literal instead, matching this file's own
 * `toMatch(/reverted/i)` assertions against the SAME text elsewhere. */
const ISSUE_TX_REVERTED_MESSAGE = "Transaction reverted on chain - you can issue again.";

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
 * UI COVERAGE (the earlier "unreachable UI" deviation recorded here was DISPROVED): the mint
 * plan's Tests section also asks for "the wizard shows the revert message + re-enabled Issue" and
 * "both-theme screenshots of the revert state" - i.e. driving `TagIssueWizard` itself, not just the
 * API underneath it. `TagIssueWizard` (like `TagsTable`/`VerifySessionPanel`/`SetupWizard`) does
 * render nothing but a "Connect your operator wallet" banner while `useAccount().isConnected` is
 * false, but `wagmi/connectors` - this app's own already-installed dependency, one import away -
 * exports `mock`, a real test connector maintained by wagmi itself (not a hand-rolled
 * `window.ethereum` shim). `src/lib/wagmi.ts` now registers it alongside the real `metaMask()`
 * connector, gated behind `NEXT_PUBLIC_E2E_MOCK_WALLET_ADDRESS` (unset in any real deployment, so
 * production's connector list is unchanged), and `src/components/Providers.tsx` auto-connects it
 * on mount under the SAME gate (the mock connector's own `isAuthorized` has no genuine prior
 * connection to restore on a fresh mount, so it does not auto-fire on its own). The tests below
 * that render `TagIssueWizard` for real (search "UI:" below) rely on that gate - `playwright.config
 * .ts`'s `webServer.env` turns it on for this whole suite, harmlessly, since no OTHER spec ever
 * navigates to a wallet-gated page (`/tags`, `/tags/issue`, `/verify`, `/setup`) today.
 *
 * The API-level tests below this comment (seeding a `MintSession` directly and driving it through
 * `confirm`/`retry`/the worker's boot recovery) are UNCHANGED in approach: the thing they test - the
 * server-side reconciliation `reconcileAnchoredSession` performs - runs identically no matter what
 * triggers it, and stays the more precise way to prove that logic. The UI tests below them are
 * additive: proof that the wizard actually renders what that server-side state means, in a real
 * browser, surviving a real `page.reload()`, in both themes.
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

/** Same idiom as calendar-services.spec.ts/booking-config-timezone.spec.ts/appointment-tagging
 * .spec.ts/mobile-booking.spec.ts's own `setTheme` - the app-wide theme radio group (Topbar), not
 * anything specific to this page. */
async function setTheme(page: Page, theme: "Light" | "Dark") {
  await page.getByRole("radio", {name: theme}).click();
  await expect(page.getByRole("radio", {name: theme})).toHaveAttribute("aria-checked", "true");
  if (theme === "Dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
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

/** Seeds a `MintSession` directly in the exact shape `markSessionRevertedReady` leaves one in - a
 * `ready` session with `lastIssueError` set and the dead tx moved into `failedIssueTxHashes` - the
 * state the UI tests below need to render, without re-driving the issuing->confirm->revert
 * transition itself (already covered by the API-level test above this one). */
async function seedReadySessionWithRevert(): Promise<{sessionId: string; root: string; dogTagIdField: string}> {
  const sessionId = randomUUID();
  const root = randomHex(32);
  const dogTagIdField = String(Math.floor(Math.random() * 1_000_000) + 1);
  const oldTxHash = randomHex(32);
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
    status: "ready",
    root,
    lastIssueError: ISSUE_TX_REVERTED_MESSAGE,
    failedIssueTxHashes: [oldTxHash],
    protocolVersion: "dogtag-v2/1",
    tokenExp: now + 600,
    createdAt: new Date(),
  });
  return {sessionId, root, dogTagIdField};
}

/** WP4.12V - creates a client via the API (the same fixture-via-API convention
 * appointment-tagging.spec.ts's own `createClient` uses), for tests that need one to reach
 * TagIssueWizard's "1. Client" step without seeding one directly into Mongo. */
async function createClient(page: Page, name: string): Promise<{clientId: string}> {
  const res = await page.request.post("/api/clients", {data: {name}});
  expect(res.ok()).toBe(true);
  return res.json();
}

/** WP4.12V - a valid, unconsumed 32-lowercase-hex token (the `hexToken32`/`BindToken.token`
 * grammar - NOT 0x-prefixed, unlike this file's own `randomHex`), bound to `sessionId`. */
function randomToken(): string {
  return randomBytes(16).toString("hex");
}

/** Seeds a `MintSession` at `status: "pending"` with a real `BindToken`, mirroring exactly what
 * `POST /api/tags/issue/start` creates - for `GET /p/:token` resolve-payload tests that need a
 * real token rather than driving the full preflight/allocate start flow (this suite's own
 * established convention: every other `seed*Session` helper above seeds the session directly for
 * the SAME reason - the thing under test here is the resolve route's field passthrough, not
 * session creation). */
async function seedPendingSessionWithProfile(profile: Record<string, unknown>): Promise<{token: string}> {
  const sessionId = randomUUID();
  const dogTagIdField = String(Math.floor(Math.random() * 1_000_000) + 1);
  const now = Math.floor(Date.now() / 1000);
  const token = randomToken();
  await mongoClient.db().collection("mintsessions").insertOne({
    sessionId,
    dogTagIdDec: dogTagIdField,
    dogTagIdField,
    ownerIdentity: {},
    identityLeaves: [],
    petName: "Blaze",
    microchip: {},
    profile: {weightHistory: [], ...profile},
    status: "pending",
    protocolVersion: "dogtag-v2/1",
    tokenExp: now + 600,
    createdAt: new Date(),
  });
  await mongoClient.db().collection("bindtokens").insertOne({token, sessionId, exp: now + 600, consumed: false});
  return {token};
}

/** Seeds a fresh `MintSession` at `status: "ready"` - no prior attempt, no `lastIssueError` - the
 * ordinary "the device already bound its profile tree, issue it on chain" state the wizard's
 * "Issue on chain" button appears for. WP4.5 grade-fix MAJOR 2's gas-wire-assertion test drives
 * this one through a real click. */
async function seedReadySession(): Promise<{sessionId: string; root: string; dogTagIdField: string}> {
  const sessionId = randomUUID();
  const root = randomHex(32);
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
    status: "ready",
    root,
    protocolVersion: "dogtag-v2/1",
    tokenExp: now + 600,
    createdAt: new Date(),
  });
  return {sessionId, root, dogTagIdField};
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
 * WP4.5 grade-fix MAJOR 3 - the retry route's OWN confirmed-revert branch
 * (src/app/api/tags/issue/[sessionId]/retry/route.ts:63-76) had zero coverage: every revert test
 * above drives the SAME underlying `reconcileAnchoredSession` through the CONFIRM route instead.
 * Reuses the exact recipe the test just above this one uses to produce an `error`/`verify` session
 * with its `root`/`txHash` both still intact (seed `issuing` -> script the receipt as mined SUCCESS
 * but non-anchoring -> confirm -> 400) - that state is the ONLY way to reach `/retry`'s revert
 * branch at all, since the route requires `status: "error"` up front and this is the one path that
 * reaches `error` without ever clearing `root`/`txHash`. Then flips that SAME tx's scripted receipt
 * to reverted and calls `/retry`, landing squarely in the branch this test is actually about.
 */
test("retry on an error session whose tx later reads back reverted: reconciles straight to ready on the SAME root, never arms a fresh bind token", async ({page}) => {
  const {sessionId, root, txHash} = await seedIssuingSession();
  await setRpcReceipt(txHash, "success"); // mined, but (unscripted) profileRoot/isValid disagree
  const firstConfirm = await page.request.post(`/api/tags/issue/${sessionId}/confirm`);
  expect(firstConfirm.status()).toBe(400);

  const midway = await mongoClient.db().collection("mintsessions").findOne({sessionId});
  expect(midway?.status).toBe("error");
  expect(midway?.errorStage).toBe("verify");
  expect(midway?.root).toBe(root);
  expect(midway?.txHash).toBe(txHash); // still intact - retry's revert branch needs this precondition

  // The SAME tx now reads back as a confirmed revert instead of a merely-non-anchoring success.
  await setRpcReceipt(txHash, "reverted");

  const retryRes = await page.request.post(`/api/tags/issue/${sessionId}/retry`, {
    data: {operatorAddress: "0x1234567890123456789012345678901234567890"},
  });
  expect(retryRes.ok()).toBe(true);
  const retryBody = await retryRes.json();
  expect(retryBody.status).toBe("ready");
  expect(retryBody.root).toBe(root); // the SAME root - never discarded/re-armed
  expect(retryBody.lastIssueError).toMatch(/reverted/i);

  const stored = await mongoClient.db().collection("mintsessions").findOne({sessionId});
  expect(stored?.status).toBe("ready");
  expect(stored?.root).toBe(root);
  expect(stored?.lastIssueError).toMatch(/reverted/i);
  expect(stored?.failedIssueTxHashes).toEqual([txHash]);
  expect(stored?.txHash).toBeUndefined(); // the dead tx must not linger as if it were still live
  expect(stored?.errorStage).toBeUndefined(); // cleared, not left over from the PRIOR error round

  // This branch returns EARLY (route.ts:63-76), before the "arm a fresh bind token" code below it
  // ever runs - no BindToken.create for this session, unlike the OTHER retry outcome (a genuine
  // fresh-token re-arm) which would have created exactly one.
  const bindTokenCount = await mongoClient.db().collection("bindtokens").countDocuments({sessionId});
  expect(bindTokenCount).toBe(0);
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

/**
 * WP4.5 grade-fix MAJOR 1 - the revert-state UI, driven for real through the env-gated mock wallet
 * connector (this file's own top-of-file doc comment). `seedReadySessionWithRevert` puts a session
 * in exactly the state `markSessionRevertedReady` leaves one in; loading the wizard against that
 * session id (the SAME `?session=` resume mechanism `/tags`'s "in progress" list already uses)
 * proves the wizard's `session.lastIssueError`/`session.status === "ready"` branch actually renders
 * it - the DOM assertion the mint plan's own Tests section asked for.
 */
test("UI: a ready session with a recorded revert shows the banner, the sponsorship sentence, and a re-enabled Issue button", async ({page}) => {
  const {sessionId} = await seedReadySessionWithRevert();

  await page.goto(`/tags/issue?session=${sessionId}`);

  // Generous timeout: this is the FIRST navigation to a wallet-gated page in the whole suite, so it
  // pays the mock connector's own connect round trip on top of the cold-`next dev`-compile budget
  // every other spec's first navigation already carries (see signInAsStaff's own comments elsewhere
  // in this suite for that class of flake).
  await expect(page.getByText("Previous attempt did not confirm")).toBeVisible({timeout: 15_000});
  await expect(page.getByText(ISSUE_TX_REVERTED_MESSAGE)).toBeVisible();

  const issueButton = page.getByRole("button", {name: "Issue on chain"});
  await expect(issueButton).toBeVisible();
  await expect(issueButton).toBeEnabled();

  await expect(
    page.getByText("Gas is fronted by your wallet and refunded by the clinic's clone on success (failed attempts are not refunded)."),
  ).toBeVisible();
});

/**
 * WP4.5 grade-fix MAJOR 1 - the OTHER half of the reload-survival proof this track's hot-fix
 * (commit 2eb9e51) needed but this suite could previously only prove at the poll-payload level
 * (the "attestation-signed state survives a reload" test above): a real `page.reload()`, on a real
 * `TagIssueWizard`, through the mock wallet connector. `dogTag.attestation` is written directly at
 * seed time (the same field `POST .../attestation` writes - unchanged by this track), so this test
 * exercises only the NEW poll-derivation the mint plan's fix is actually about, not the
 * pre-existing signature-storage write path.
 */
test("UI: the attestation done-badge survives a real page reload, derived from the linked Pet's own record rather than client-local state", async ({page}) => {
  const petId = randomUUID();
  await mongoClient.db().collection("pets").insertOne({
    petId,
    name: "Blaze",
    microchip: {},
    weightHistory: [],
    ownerClientIds: [],
    dogTag: {
      attestation: {
        domain: {name: "DogTagIssuerAttestation", version: "1", chainId: 135, verifyingContract: CLONE_ADDRESS},
        message: {
          merkleRoot: randomHex(32),
          recordType: `0x${"11".repeat(32)}`,
          issuerContract: CLONE_ADDRESS,
          issuerName: "Example Vet Clinic",
          issuerDomain: "example-vet.test",
        },
        signature: `0x${"22".repeat(65)}`,
        issuerSigner: "0x1111111111111111111111111111111111111111",
      },
    },
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

  await page.goto(`/tags/issue?session=${sessionId}`);
  await expect(page.getByText("Tag bound successfully.")).toBeVisible({timeout: 15_000});
  await expect(page.getByText("Issuer attestation signed")).toBeVisible();
  await expect(page.getByRole("button", {name: "Sign issuer attestation"})).toHaveCount(0);

  await page.reload();

  // The hot-fixed bug this proves the FIX of: a client-local `useState` starting `false` on every
  // mount would re-offer the button here instead, even though the attestation was never actually
  // lost - only the tab was.
  await expect(page.getByText("Issuer attestation signed")).toBeVisible({timeout: 15_000});
  await expect(page.getByRole("button", {name: "Sign issuer attestation"})).toHaveCount(0);
});

/**
 * WP4.5 grade-fix MAJOR 1 - both-theme screenshots of the revert state, the repo's own `setTheme`
 * idiom (calendar-services.spec.ts/booking-config-timezone.spec.ts/others), saved under the
 * scratchpad per this track's own instructions.
 */
test("UI: both-theme screenshots of the revert state", async ({page}) => {
  const {sessionId} = await seedReadySessionWithRevert();

  for (const theme of ["Light", "Dark"] as const) {
    await page.goto(`/tags/issue?session=${sessionId}`);
    await expect(page.getByText("Previous attempt did not confirm")).toBeVisible({timeout: 15_000});
    await setTheme(page, theme);
    await page.screenshot({path: `${SHOTS_DIR}/tag-issue-revert-${theme.toLowerCase()}.png`});
  }
});

/**
 * WP4.5 grade-fix MAJOR 2 - the wire-level gas assertion the mint plan's own Tests section asked
 * for: not that `legacyTxWithGas` COMPUTES headroom (tests/unit/chainWrite.test.ts, a fake
 * PublicClient) or that a Node-side viem client relays it correctly
 * (tests/unit/chainWriteGas.integration.test.ts) - both already passed - but that a REAL browser
 * wallet write, through the mock connector exactly the same way a real MetaMask write would go,
 * actually SENDS it. Before the CORS fix (rpcStub.ts, previous commit), every browser-side call to
 * this stub failed preflight silently, so `legacyTxWithGas`'s fail-open `catch` always won and the
 * wallet's own bare (un-headroomed) estimate went out instead - invisibly, since the write still
 * "succeeded" as far as the wizard could tell. This is the assertion that would have caught that.
 */
test("UI: the Issue on chain click sends eth_sendTransaction with gas headroom over the stubbed estimate", async ({page}) => {
  const {sessionId} = await seedReadySession();
  await setRpcGasEstimate(335_037n);

  await page.goto(`/tags/issue?session=${sessionId}`);
  const issueButton = page.getByRole("button", {name: "Issue on chain"});
  await expect(issueButton).toBeEnabled({timeout: 15_000});
  await issueButton.click();

  // The click's own handler posts the wallet's returned hash to `.../tx` (which flips the session
  // to `issuing`) and starts polling - waiting for this text is waiting for the ENTIRE round trip
  // (estimateGas through this stub, then the mock connector's own eth_sendTransaction through it,
  // then the app's own POST) to have already happened, not a fixed sleep.
  await expect(page.getByText("Waiting for the transaction to confirm...")).toBeVisible({timeout: 15_000});

  const sent = await getLastSendTransaction();
  expect(sent).not.toBeNull();
  // 335_037 + 335_037/5 (67_007, truncated) + 30_000 = 432_044 - exactly legacyTxWithGas's own
  // formula, over the wire, sent by the REAL wallet-write code path rather than asserted against
  // the function's return value directly.
  expect(sent?.gas).toBe(`0x${(432_044).toString(16)}`);
  expect(sent?.type).toBe("0x0"); // ROAX-only-accepts-legacy, enforced by legacyTx
  expect(String(sent?.to).toLowerCase()).toBe(CLONE_ADDRESS.toLowerCase());
});

/**
 * WP4.12V (Kenneth issue 2) - plan section 3.2 item 8's Playwright coverage: the issue wizard's
 * "4. Pet profile" section shows the three new inputs with the plan's own labels and placeholders.
 * A NEW pet name (not an existing one) is enough to reach this section - no session start, no
 * chain interaction needed, since the thing under test is purely what TagIssueWizard renders.
 */
test("UI: Pet profile section shows Color / Government registration id / Registration authority inputs", async ({page}) => {
  await createClient(page, "WP412V Wizard Client");

  await page.goto("/tags/issue");
  await page.getByRole("combobox", {name: "Search clients"}).fill("WP412V Wizard Client");
  await page.getByRole("option", {name: /^WP412V Wizard Client/}).click();
  await page.getByLabel("New pet name").fill("WP412V Wizard Pet");

  await expect(page.getByLabel("Color")).toBeVisible();
  await expect(page.getByLabel("Color")).toHaveAttribute("placeholder", "brown");
  await expect(page.getByLabel("Government registration id")).toHaveAttribute("placeholder", "e.g. AVS licence number");
  await expect(page.getByLabel("Registration authority")).toHaveAttribute("placeholder", "e.g. AVS Singapore");

  // Not just visible - actually usable, and independent of each other.
  await page.getByLabel("Color").fill("brown");
  await page.getByLabel("Government registration id").fill("SGP-DOG-0042");
  await page.getByLabel("Registration authority").fill("AVS Singapore");
  await expect(page.getByLabel("Color")).toHaveValue("brown");
  await expect(page.getByLabel("Government registration id")).toHaveValue("SGP-DOG-0042");
  await expect(page.getByLabel("Registration authority")).toHaveValue("AVS Singapore");
});

/**
 * WP4.12V - plan section 3.2 item 8: "a started session's resolve JSON carries them". Seeds a
 * pending session with a real BindToken (this suite's own established convention for reaching a
 * specific session state without re-driving the full start flow) and reads `GET /p/:token`
 * directly, proving the passthrough against the REAL running app + REAL e2e mongo - the precise
 * presence/absence contract itself is unit-tested more thoroughly in
 * tests/unit/api/mintSessionResolveRoute.integration.test.ts; this is the holistic, fully
 * integrated proof the plan's own wording asks for.
 */
test("a started session's resolve JSON carries color/registrationId/registrationAuthority when set", async ({page}) => {
  const {token} = await seedPendingSessionWithProfile({
    color: "brown",
    registrationId: "SGP-DOG-0042",
    registrationAuthority: "AVS Singapore",
  });

  const res = await page.request.get(`/p/${token}`);
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.pet.profile.color).toBe("brown");
  expect(body.pet.profile.registrationId).toBe("SGP-DOG-0042");
  expect(body.pet.profile.registrationAuthority).toBe("AVS Singapore");
});

/**
 * WP4.12V - plan section 3.2 item 8: "pet form round-trips them". Drives the REAL PetForm UI (not
 * just the API): create via `/pets/new`, land on the pet detail page (PetForm's own
 * `router.push` on success), and confirm the values shown there were actually read back from a
 * fresh server render (`Pet.findOne` + `toPlain`, `src/app/(app)/pets/[id]/page.tsx`), not merely
 * client state left over from the save.
 */
test("pet form round-trips color/registrationId/registrationAuthority", async ({page}) => {
  const client = await createClient(page, "WP412V Pet Form Client");

  await page.goto(`/pets/new?ownerClientId=${client.clientId}`);
  await page.getByLabel("Name").fill("WP412V Pet Form Pet");
  await page.getByLabel("Color").fill("brown");
  await page.getByLabel("Government registration id").fill("SGP-DOG-0042");
  await page.getByLabel("Registration authority").fill("AVS Singapore");
  await page.getByRole("button", {name: "Create pet"}).click();

  // NOT /\/pets\/[^/]+$/ - that also matches the STARTING /pets/new?ownerClientId=... url (the
  // query string contains no further "/"), so it would be satisfied instantly, before the actual
  // post-create navigation ever happens, and the assertions below would then be reading the OLD
  // /pets/new page's own lingering client state rather than a fresh server render. petId is a
  // randomUUID(), so anchor on that exact shape instead - it can never match "new".
  await expect(page).toHaveURL(/\/pets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, {timeout: 15_000});
  await expect(page.getByLabel("Color")).toHaveValue("brown");
  await expect(page.getByLabel("Government registration id")).toHaveValue("SGP-DOG-0042");
  await expect(page.getByLabel("Registration authority")).toHaveValue("AVS Singapore");

  // Reload - a real server render from a freshly persisted document, not client-side leftover state.
  await page.reload();
  await expect(page.getByLabel("Color")).toHaveValue("brown");
  await expect(page.getByLabel("Government registration id")).toHaveValue("SGP-DOG-0042");
  await expect(page.getByLabel("Registration authority")).toHaveValue("AVS Singapore");
});
