import {expect, test, type Page} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {MongoClient} from "mongodb";
import {E2E_MONGO_URI} from "./mongo-fixture";
import {encodeRefundSkippedLog, getLastSentTxHash, resetRpcStub, setRpcReceipt, setRpcScenario} from "./rpcStub";

/**
 * End-to-end coverage for plans/wp4.19-seamless-gas.md's vet-side checklist item V2: after every
 * confirmed clone write, the app decodes the mined receipt's own logs and says whether the clinic's
 * clone actually refunded the gas. Follows mint-issue-revert.spec.ts's own established conventions
 * (mock wallet connector, seeded MintSession/Pet rows, `getLastSentTxHash` wire-level round trips).
 */

const CLONE_ADDRESS = "0x7b9bf16f0e39AdF8c38d8491F4C7E9C17E85D703"; // same literal every sibling suite in this repo already configures
const DOGTAG_SBT_ADDRESS = "0x276101555b2cd92be0fb85ff908e02281d6a3cf9"; // playwright.config.ts's own DOGTAG_SBT_ADDRESS
const MOCK_WALLET_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // playwright.config.ts's own NEXT_PUBLIC_E2E_MOCK_WALLET_ADDRESS default

function randomHex(bytes: number): string {
  return "0x" + Array.from({length: bytes * 2}, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

async function signInAsStaff(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", {name: "Dev sign in (test only)"}).click();
  await expect(page).toHaveURL(/\/dashboard$/, {timeout: 15_000});
}

async function configureClinic(page: Page) {
  const res = await page.request.patch("/api/settings", {
    data: {cloneAddress: CLONE_ADDRESS, businessProfile: {name: "Example Vet Clinic"}},
  });
  expect(res.ok()).toBe(true);
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

/** Same shape mint-issue-revert.spec.ts's own `seedReadySession` seeds - a fresh MintSession ready
 * for the wizard's "Issue on chain" button. */
async function seedReadySession(): Promise<{sessionId: string; dogTagIdField: string; root: string}> {
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
  return {sessionId, dogTagIdField, root};
}

/** After the wallet's `issueTag` tx is scripted mined-success, `reconcileAnchoredSession`
 * (`/confirm`'s own decisive check) needs BOTH `profileRoot` and `isValid` to agree the root
 * actually anchored before it will report `status: "bound"` - mirrors mint-issue-revert.spec.ts's
 * own "retry after a revert" test's identical two scenario calls. */
async function scriptAnchored(dogTagIdField: string, root: string): Promise<void> {
  await setRpcScenario("profileRoot", DOGTAG_SBT_ADDRESS, [dogTagIdField], root);
  await setRpcScenario("isValid", CLONE_ADDRESS, [root], true);
}

/** Same shape mint-issue-revert.spec.ts's own `seedIssuedActivePet` seeds - an active tag the
 * /tags Revoke row action targets. */
async function seedIssuedActivePet(): Promise<{petId: string; dogTagIdField: string}> {
  const petId = randomUUID();
  const dogTagIdField = String(Math.floor(Math.random() * 1_000_000) + 1);
  await mongoClient.db().collection("pets").insertOne({
    petId,
    name: "Blaze",
    microchip: {},
    weightHistory: [],
    ownerClientIds: [],
    dogTag: {
      dogTagIdDec: dogTagIdField,
      dogTagIdField,
      root: randomHex(32),
      status: "active",
      cloneAddress: CLONE_ADDRESS,
      issuedTx: randomHex(32),
      issuedAt: new Date(),
    },
    searchKey: "blaze",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return {petId, dogTagIdField};
}

test.describe("V2 - refund feedback after a confirmed clone write", () => {
  test("issueTag: no RefundSkipped log in the receipt -> 'Gas refunded by the clinic contract'", async ({page}) => {
    const {sessionId, dogTagIdField, root} = await seedReadySession();
    await page.goto(`/tags/issue?session=${sessionId}`);
    const issueButton = page.getByRole("button", {name: "Issue on chain"});
    await expect(issueButton).toBeEnabled({timeout: 15_000});
    await issueButton.click();

    await expect.poll(async () => getLastSentTxHash(), {timeout: 15_000}).not.toBeNull();
    const hash = (await getLastSentTxHash())!;
    await scriptAnchored(dogTagIdField, root);
    await setRpcReceipt(hash, "success"); // no logs scripted at all - the "nothing to see" default

    await expect(page.getByText("Tag bound successfully.")).toBeVisible({timeout: 15_000});
    await expect(page.getByText("Gas refunded by the clinic contract")).toBeVisible({timeout: 15_000});
  });

  test("issueTag: a scripted RefundSkipped log -> 'Refund skipped, the clinic's refund pool is low: tell your admin'", async ({page}) => {
    const {sessionId, dogTagIdField, root} = await seedReadySession();
    await page.goto(`/tags/issue?session=${sessionId}`);
    const issueButton = page.getByRole("button", {name: "Issue on chain"});
    await expect(issueButton).toBeEnabled({timeout: 15_000});
    await issueButton.click();

    await expect.poll(async () => getLastSentTxHash(), {timeout: 15_000}).not.toBeNull();
    const hash = (await getLastSentTxHash())!;
    const log = encodeRefundSkippedLog(CLONE_ADDRESS, MOCK_WALLET_ADDRESS, 50_000_000_000_000_000n);
    await scriptAnchored(dogTagIdField, root);
    await setRpcReceipt(hash, "success", [log]);

    await expect(page.getByText("Tag bound successfully.")).toBeVisible({timeout: 15_000});
    await expect(page.getByText("Refund skipped, the clinic's refund pool is low: tell your admin")).toBeVisible({timeout: 15_000});
  });

  test("revokeTag on the Tags page: a scripted RefundSkipped log surfaces in the snackbar", async ({page}) => {
    const {petId, dogTagIdField} = await seedIssuedActivePet();
    void petId;
    await page.goto("/tags");
    const row = page.getByRole("row", {name: new RegExp(dogTagIdField)});
    await expect(row).toBeVisible({timeout: 15_000});
    await row.getByRole("button", {name: "Revoke"}).click();

    await expect.poll(async () => getLastSentTxHash(), {timeout: 15_000}).not.toBeNull();
    const hash = (await getLastSentTxHash())!;
    const log = encodeRefundSkippedLog(CLONE_ADDRESS, MOCK_WALLET_ADDRESS, 1n);
    await setRpcReceipt(hash, "success", [log]);

    await expect(page.getByText(/Refund skipped, the clinic's refund pool is low: tell your admin/)).toBeVisible({timeout: 15_000});
  });
});
