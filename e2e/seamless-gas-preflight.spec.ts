import {expect, test, type Page} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {MongoClient} from "mongodb";
import {E2E_MONGO_URI} from "./mongo-fixture";
import {getLastSendTransaction, resetRpcStub, setRpcBalance, setRpcGasEstimate} from "./rpcStub";

/**
 * End-to-end coverage for plans/wp4.19-seamless-gas.md's vet-side checklist item V3: issue/revoke/
 * reactivate refuse to send outright when the connected wallet cannot even cover that write's own
 * gas floor at the current gas price. Follows mint-issue-revert.spec.ts's own established
 * conventions (mock wallet connector, seeded MintSession/Pet rows, `getLastSendTransaction`
 * wire-level assertions).
 */

const CLONE_ADDRESS = "0x7b9bf16f0e39AdF8c38d8491F4C7E9C17E85D703"; // same literal every sibling suite in this repo already configures
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
async function seedReadySession(): Promise<{sessionId: string; dogTagIdField: string}> {
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
  return {sessionId, dogTagIdField};
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

test.describe("V3 - pre-flight balance check refuses to send", () => {
  test("issueTag: a scripted ZERO balance refuses to send, shows the needed-PLASMA message and a top-up request, and never calls eth_sendTransaction", async ({
    page,
  }) => {
    await setRpcBalance(MOCK_WALLET_ADDRESS, 0n);
    const {sessionId} = await seedReadySession();
    await page.goto(`/tags/issue?session=${sessionId}`);
    const issueButton = page.getByRole("button", {name: "Issue on chain"});
    await expect(issueButton).toBeEnabled({timeout: 15_000});
    await issueButton.click();

    await expect(page.getByText(/Your wallet needs about .* PLASMA for this transaction; ask your admin for a top-up/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Waiting for the transaction to confirm...")).toHaveCount(0);
    expect(await getLastSendTransaction()).toBeNull(); // refused before ever reaching the wallet
  });

  test("revokeTag on the Tags page: a scripted ZERO balance refuses to send and shows the same message next to the row", async ({page}) => {
    await setRpcBalance(MOCK_WALLET_ADDRESS, 0n);
    const {dogTagIdField} = await seedIssuedActivePet();
    await page.goto("/tags");
    const row = page.getByRole("row", {name: new RegExp(dogTagIdField)});
    await expect(row).toBeVisible({timeout: 15_000});
    await row.getByRole("button", {name: "Revoke"}).click();

    await expect(row.getByText(/Your wallet needs about .* PLASMA for this transaction; ask your admin for a top-up/)).toBeVisible({
      timeout: 15_000,
    });
    expect(await getLastSendTransaction()).toBeNull();
  });

  test("a healthy balance is unaffected by the preflight check - issueTag still sends normally", async ({page}) => {
    const {sessionId} = await seedReadySession();
    await setRpcGasEstimate(335_037n);
    await page.goto(`/tags/issue?session=${sessionId}`);
    const issueButton = page.getByRole("button", {name: "Issue on chain"});
    await expect(issueButton).toBeEnabled({timeout: 15_000});
    await issueButton.click();
    await expect(page.getByText("Waiting for the transaction to confirm...")).toBeVisible({timeout: 15_000});
    expect(await getLastSendTransaction()).not.toBeNull();
  });
});
