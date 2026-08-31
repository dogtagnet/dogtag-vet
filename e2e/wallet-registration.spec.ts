import {expect, test, type Page} from "@playwright/test";
import {MongoClient} from "mongodb";
import {privateKeyToAccount, generatePrivateKey} from "viem/accounts";
import {E2E_MONGO_URI} from "./mongo-fixture";

/**
 * End-to-end coverage for plans/wp4.2-client-wallet-registration.md's dogtag-vet flow: happy path,
 * expired token, reused token, wrong-signer signature, and revoke.
 *
 * The signing side below is a DELIBERATELY independent, hand-rolled copy of the
 * `ClientRegistration` EIP-712 struct - not imported from `src/lib/registration/eip712.ts` - the
 * same "keep a separate copy" philosophy `tests/unit/eip712ClientRegistration.vectors.test.ts`
 * documents for its own fixture-pinning test. The point of THIS suite is to prove the real,
 * running server accepts a signature built by a genuinely independent client implementation
 * (`privateKeyToAccount` + `signTypedData`), the same way a real wallet app would produce it -
 * not to re-exercise the server's own module a second time from the outside.
 */
const PRIMARY_TYPE = "ClientRegistration" as const;
const TYPES = {
  ClientRegistration: [
    {name: "clinic", type: "address"},
    {name: "clientHash", type: "bytes32"},
    {name: "registrationId", type: "bytes32"},
    {name: "wallet", type: "address"},
    {name: "issuedAt", type: "uint64"},
    {name: "blockNumber", type: "uint64"},
    {name: "deadline", type: "uint64"},
  ],
} as const;

function registrationIdToHex32(uuid: string): `0x${string}` {
  const hex = uuid.replace(/-/g, "");
  return `0x${hex}${"0".repeat(32)}` as `0x${string}`;
}

interface Challenge {
  clinicName: string;
  clone: `0x${string}`;
  chainId: number;
  maskedClientName: string;
  clientHash: `0x${string}`;
  registrationId: string;
  issuedAt: number;
  blockNumber: number;
  deadline: number;
  ttlSecs: number;
}

/** Signs the challenge's own fields for `claimedWallet` (defaults to the signer's own address -
 * pass a DIFFERENT address to build a deliberately wrong-signer submission). */
async function signChallenge(
  challenge: Challenge,
  signer: ReturnType<typeof privateKeyToAccount>,
  claimedWallet?: `0x${string}`,
) {
  const domain = {
    name: "DogTagClientRegistration" as const,
    version: "1" as const,
    chainId: challenge.chainId,
    verifyingContract: challenge.clone,
  };
  const message = {
    clinic: challenge.clone,
    clientHash: challenge.clientHash,
    registrationId: registrationIdToHex32(challenge.registrationId),
    wallet: claimedWallet ?? signer.address,
    issuedAt: BigInt(challenge.issuedAt),
    blockNumber: BigInt(challenge.blockNumber),
    deadline: BigInt(challenge.deadline),
  };
  const signature = await signer.signTypedData({domain, types: TYPES, primaryType: PRIMARY_TYPE, message});
  return {wallet: claimedWallet ?? signer.address, signature};
}

async function signInAsStaff(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", {name: "Dev sign in (test only)"}).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** Idempotent: PATCHing the same clinic settings before every test is cheap and keeps each test
 * self-sufficient regardless of execution order. `cloneAddress` is any syntactically valid
 * address - this route never checks it against the chain (unlike mint's preflight), only that it
 * and a business name are SET. */
async function configureClinic(page: Page) {
  const res = await page.request.patch("/api/settings", {
    data: {cloneAddress: "0x7b9bf16f0e39AdF8c38d8491F4C7E9C17E85D703", businessProfile: {name: "Example Vet Clinic"}},
  });
  expect(res.ok()).toBe(true);
}

async function createClient(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/clients", {data: {name}});
  expect(res.ok()).toBe(true);
  const body = await res.json();
  return body.clientId as string;
}

async function startRegistrationSession(page: Page, clientId: string): Promise<{token: string; registrationId: string}> {
  const res = await page.request.post(`/api/clients/${clientId}/wallet-registrations`);
  expect(res.ok()).toBe(true);
  return res.json();
}

async function fetchChallenge(page: Page, token: string, clientIp: string): Promise<Challenge> {
  const res = await page.request.get(`/w/${token}`, {headers: {"cf-connecting-ip": clientIp}});
  expect(res.ok()).toBe(true);
  return res.json();
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
});

test("happy path: staff registers a wallet, owner scans/signs, the panel shows it registered", async ({page}) => {
  const clientId = await createClient(page, "Jordan Alvarez");
  await page.goto(`/clients/${clientId}`);

  await page.getByRole("button", {name: "Register wallet"}).click();
  const link = page.getByTestId("wallet-registration-link");
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  expect(href).toMatch(/\/w\/[0-9a-f]{32}$/);
  const token = href!.match(/\/w\/([0-9a-f]{32})$/)![1]!;

  await expect(page.getByText("Waiting for scan...")).toBeVisible();

  const challenge = await fetchChallenge(page, token, "10.1.1.1");
  expect(challenge.maskedClientName).toBe("J***** A******");
  expect(challenge.clinicName).toBe("Example Vet Clinic");

  const account = privateKeyToAccount(generatePrivateKey());
  const {wallet, signature} = await signChallenge(challenge, account);

  const completeRes = await page.request.post(`/w/${token}/complete`, {
    data: {wallet, signature},
    headers: {"cf-connecting-ip": "10.1.1.1"},
  });
  expect(completeRes.ok()).toBe(true);
  const completeBody = await completeRes.json();
  expect(completeBody.wallet).toBe(wallet.toLowerCase());

  // The panel polls every 2s and refreshes the server-rendered list on success - wait for the
  // registered address to actually appear as a row (AddressChip renders it truncated, but
  // MonoValue always sets `title` to the untruncated value).
  await expect(page.locator(`[title="${wallet.toLowerCase()}"]`)).toBeVisible({timeout: 15_000});
});

test("expired token: both the challenge and completion are rejected once the deadline has passed", async ({page}) => {
  const clientId = await createClient(page, "Expired Case");
  const {token} = await startRegistrationSession(page, clientId);

  const db = mongoClient.db();
  const collection = db.collection("walletregistrationsessions");
  const updateResult = await collection.updateOne({token}, {$set: {deadline: Math.floor(Date.now() / 1000) - 10}});
  expect(updateResult.matchedCount).toBe(1);

  const challengeRes = await page.request.get(`/w/${token}`, {headers: {"cf-connecting-ip": "10.1.1.2"}});
  expect(challengeRes.status()).toBe(410);
  const challengeBody = await challengeRes.json();
  expect(challengeBody.error.code).toBe("expired_or_reused");

  const account = privateKeyToAccount(generatePrivateKey());
  const completeRes = await page.request.post(`/w/${token}/complete`, {
    data: {wallet: account.address, signature: `0x${"00".repeat(65)}`},
    headers: {"cf-connecting-ip": "10.1.1.2"},
  });
  expect(completeRes.status()).toBe(410);
  const completeBody = await completeRes.json();
  expect(completeBody.error.code).toBe("expired_or_reused");
});

test("reused token: a second completion attempt against an already-consumed token is rejected", async ({page}) => {
  const clientId = await createClient(page, "Reuse Case");
  const {token} = await startRegistrationSession(page, clientId);
  const challenge = await fetchChallenge(page, token, "10.1.1.3");

  const first = privateKeyToAccount(generatePrivateKey());
  const firstSig = await signChallenge(challenge, first);
  const firstRes = await page.request.post(`/w/${token}/complete`, {data: firstSig, headers: {"cf-connecting-ip": "10.1.1.3"}});
  expect(firstRes.ok()).toBe(true);

  const second = privateKeyToAccount(generatePrivateKey());
  const secondSig = await signChallenge(challenge, second);
  const secondRes = await page.request.post(`/w/${token}/complete`, {data: secondSig, headers: {"cf-connecting-ip": "10.1.1.3"}});
  expect(secondRes.status()).toBe(410);
  const secondBody = await secondRes.json();
  expect(secondBody.error.code).toBe("expired_or_reused");
});

test("wrong-signer signature: a signature that does not recover to the claimed wallet is rejected, and burns the token", async ({page}) => {
  const clientId = await createClient(page, "Wrong Signer Case");
  const {token} = await startRegistrationSession(page, clientId);
  const challenge = await fetchChallenge(page, token, "10.1.1.4");

  const signer = privateKeyToAccount(generatePrivateKey());
  const claimedWallet = privateKeyToAccount(generatePrivateKey()).address; // NOT the signer
  const {wallet, signature} = await signChallenge(challenge, signer, claimedWallet);

  const res = await page.request.post(`/w/${token}/complete`, {data: {wallet, signature}, headers: {"cf-connecting-ip": "10.1.1.4"}});
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("signature_invalid");

  // No retry for this flow - the token is burned even though verification failed.
  const retryAccount = privateKeyToAccount(generatePrivateKey());
  const retrySig = await signChallenge(challenge, retryAccount);
  const retryRes = await page.request.post(`/w/${token}/complete`, {data: retrySig, headers: {"cf-connecting-ip": "10.1.1.4"}});
  expect(retryRes.status()).toBe(410);
});

test("revoke flow: a registered wallet can be revoked from the panel with a two-step confirm", async ({page}) => {
  const clientId = await createClient(page, "Revoke Case");
  const {token} = await startRegistrationSession(page, clientId);
  const challenge = await fetchChallenge(page, token, "10.1.1.5");
  const account = privateKeyToAccount(generatePrivateKey());
  const {wallet, signature} = await signChallenge(challenge, account);
  const completeRes = await page.request.post(`/w/${token}/complete`, {
    data: {wallet, signature},
    headers: {"cf-connecting-ip": "10.1.1.5"},
  });
  expect(completeRes.ok()).toBe(true);

  await page.goto(`/clients/${clientId}`);
  const row = page.locator("tr", {has: page.locator(`[title="${wallet.toLowerCase()}"]`)});
  await expect(row.getByText("Active", {exact: true})).toBeVisible();

  await row.getByRole("button", {name: "Revoke"}).click();
  await row.getByRole("button", {name: "Confirm revoke"}).click();
  // `{exact: true}` matters here: the row's own collapsed receipt JSON contains the literal key
  // `"revokedAt"`, which a non-exact (substring, case-insensitive) match against "Revoked" also
  // matches - a real strict-mode violation this suite's first run against the live app caught.
  await expect(row.getByText("Revoked", {exact: true})).toBeVisible();
});
