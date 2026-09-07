import {expect, test, type Page} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {MongoClient} from "mongodb";
import {privateKeyToAccount, generatePrivateKey} from "viem/accounts";
import {E2E_MONGO_URI} from "./mongo-fixture";
import {getLastSentTxHash, resetRpcStub, setRpcReceipt, setRpcScenario} from "./rpcStub";

/**
 * End-to-end coverage for WP4.15 multi-owner (PLANNED - `DelegationRegistry`/`VetIssuer.
 * addSecondaryOwner` are not deployed on any real chain; this suite drives the vet portal against
 * `rpcStub.ts`, exactly like every other on-chain-write suite in this repo). Plan section 14.1
 * item V6.
 *
 * The `DelegationClaim` EIP-712 struct below is a DELIBERATELY independent, hand-rolled copy - not
 * imported from `src/lib/delegation/eip712.ts` - the same "keep a separate copy" philosophy
 * `wallet-registration.spec.ts`'s own header comment documents: the point of this suite is to
 * prove the real, running server accepts a signature built by a genuinely independent client
 * implementation, the way a real phone would produce it.
 *
 * The vet server never cryptographically validates `commitment` itself (it is an opaque
 * `Poseidon2(Ax,Ay)` value only the FUTURE delegate consent circuit ever checks, per
 * `docs/DELEGATION.md` section 4.1) - so this suite uses a plain random `bytes32` for it, exactly
 * as honest a stand-in as a real phone's derived value from THIS server's own point of view.
 */
const PRIMARY_TYPE = "DelegationClaim" as const;
const TYPES = {
  DelegationClaim: [
    {name: "clinic", type: "address"},
    {name: "dogTagIdField", type: "uint256"},
    {name: "commitment", type: "bytes32"},
    {name: "registrationId", type: "bytes32"},
    {name: "wallet", type: "address"},
    {name: "issuedAt", type: "uint64"},
    {name: "blockNumber", type: "uint64"},
    {name: "deadline", type: "uint64"},
  ],
} as const;

const CLONE_ADDRESS = "0x7b9bf16f0e39AdF8c38d8491F4C7E9C17E85D703";
const DELEGATION_REGISTRY_ADDRESS = "0x5f4e5a6d7c8b9a0f1e2d3c4b5a6f7e8d9c0b1a2f"; // matches playwright.config.ts
const ENTITY_REGISTRY_ADDRESS = "0x9b15a2df4e38547cbbbd635a4cd4531355bb4247"; // matches playwright.config.ts
const ENTITY_ACCOUNT = "0x3333333333333333333333333333333333333333";
// playwright.config.ts's own NEXT_PUBLIC_E2E_MOCK_WALLET_ADDRESS default (Hardhat/Anvil account #0) -
// the address the mock connector answers eth_accounts/eth_requestAccounts with, so this is what
// preflightIssuance's readOperatorWhitelisted check needs `operators(CLONE_ADDRESS, ...)` scripted
// true for.
const MOCK_OPERATOR_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function registrationIdToHex32(uuid: string): `0x${string}` {
  const hex = uuid.replace(/-/g, "");
  return `0x${hex}${"0".repeat(32)}` as `0x${string}`;
}

function randomHex32(): `0x${string}` {
  return `0x${Array.from({length: 64}, () => Math.floor(Math.random() * 16).toString(16)).join("")}` as `0x${string}`;
}

const ZERO_HEX32 = `0x${"0".repeat(64)}`;

/** The Owners card's own display status (`src/lib/delegation/ownersCardData.ts`) reads
 * `delegationLeaves` (the full 16-slot array), NOT `isSecondary` - a DIFFERENT chain read from the
 * one `reconcileDelegationWrite`'s confirm step decides on. Both must be scripted for a scenario
 * that expects the Owners card to show a commitment as active. */
function sixteenSlotLeaves(activeCommitment?: string): string[] {
  const slots = Array.from({length: 16}, () => ZERO_HEX32);
  if (activeCommitment) slots[0] = activeCommitment;
  return slots;
}

interface Challenge {
  clinicName: string;
  clone: `0x${string}`;
  chainId: number;
  dogTagIdField: string;
  petName: string;
  maskedTargetName: string;
  registrationId: string;
  issuedAt: number;
  blockNumber: number;
  deadline: number;
  ttlSecs: number;
}

async function signClaim(challenge: Challenge, signer: ReturnType<typeof privateKeyToAccount>, commitment: `0x${string}`) {
  const domain = {name: "DogTagDelegationClaim" as const, version: "1" as const, chainId: challenge.chainId, verifyingContract: challenge.clone};
  const message = {
    clinic: challenge.clone,
    dogTagIdField: BigInt(challenge.dogTagIdField),
    commitment,
    registrationId: registrationIdToHex32(challenge.registrationId),
    wallet: signer.address,
    issuedAt: BigInt(challenge.issuedAt),
    blockNumber: BigInt(challenge.blockNumber),
    deadline: BigInt(challenge.deadline),
  };
  const signature = await signer.signTypedData({domain, types: TYPES, primaryType: PRIMARY_TYPE, message});
  return {commitment, wallet: signer.address, signature};
}

async function signInAsStaff(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", {name: "Dev sign in (test only)"}).click();
  await expect(page).toHaveURL(/\/dashboard$/, {timeout: 15_000});
}

/** The DogTag-owners card, scoped - `PetTagCard`'s own DogTag status badge also renders the exact
 * text "Active", and `PetForm.tsx`'s pre-existing "Owners" FormSection (unrelated CRM contacts)
 * would otherwise collide with a bare heading lookup, so every assertion below that could
 * otherwise match either one is scoped to this card specifically. */
function ownersCard(page: Page) {
  return page.locator("section", {has: page.getByRole("heading", {name: "DogTag owners"})});
}

/** `entityAccount` (not just `cloneAddress`) is required here - `preflightIssuance`
 * (`src/lib/mint/preflight.ts`, reused as-is by `POST /api/pets/:id/delegations`'s own start
 * route) refuses "This clinic has not completed setup" without both. */
async function configureClinic(page: Page) {
  const res = await page.request.patch("/api/settings", {
    data: {cloneAddress: CLONE_ADDRESS, entityAccount: ENTITY_ACCOUNT, businessProfile: {name: "Example Vet Clinic"}},
  });
  expect(res.ok()).toBe(true);
}

/** `preflightIssuance`'s two chain reads, scripted true - `EntityRegistry.isActive` (this clinic's
 * entity) and `VetIssuer.operators` (the mock connector's own address, the "connected operator
 * wallet" every ceremony start call in this suite uses). Neither has a useful `false` default (the
 * rpcStub's own `defaultResultFor` deliberately mirrors a never-configured mapping for `operators`,
 * and has no case at all for `isActive`), so every test that starts a REAL ceremony needs both. */
async function configurePreflight(): Promise<void> {
  await setRpcScenario("isActive", ENTITY_REGISTRY_ADDRESS, [ENTITY_ACCOUNT], true);
  await setRpcScenario("operators", CLONE_ADDRESS, [MOCK_OPERATOR_ADDRESS], true);
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
  await configurePreflight();
});

/** A pet with an issued tag, and a client with a registered wallet ready to become a secondary
 * owner - the two preconditions the ceremony's own start route checks (`docs/DELEGATION.md`
 * section 4.3). Raw `insertOne`s (mirroring `mint-issue-revert.spec.ts`'s own convention) - this
 * suite is not testing issuance or wallet registration, both of which have their own coverage. */
async function seedPetAndSecondaryClient(): Promise<{petId: string; dogTagIdField: string; clientId: string; account: ReturnType<typeof privateKeyToAccount>}> {
  const petId = randomUUID();
  const dogTagIdField = String(Math.floor(Math.random() * 1_000_000) + 1);
  await mongoClient.db().collection("pets").insertOne({
    petId,
    name: "Blaze",
    microchip: {},
    weightHistory: [],
    ownerClientIds: [],
    primaryOwnerClientId: undefined,
    dogTag: {dogTagIdDec: dogTagIdField, dogTagIdField, status: "active"},
    searchKey: "blaze",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const account = privateKeyToAccount(generatePrivateKey());
  const clientId = randomUUID();
  await mongoClient.db().collection("clients").insertOne({
    clientId,
    name: "Jamie Rivera",
    petIds: [],
    wallets: [{address: account.address.toLowerCase(), registeredAt: Math.floor(Date.now() / 1000)}],
    searchKey: "jamie rivera",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return {petId, dogTagIdField, clientId, account};
}

test("Add secondary owner: full ceremony from the Owners card through on-chain confirmation", async ({page}) => {
  const {petId, dogTagIdField, account} = await seedPetAndSecondaryClient();

  await page.goto(`/pets/${petId}`);
  await expect(ownersCard(page).getByRole("heading", {name: "DogTag owners"})).toBeVisible();
  await expect(ownersCard(page).getByText("Primary not recorded")).toBeVisible();

  await page.getByRole("button", {name: "Add secondary owner"}).click();
  await page.getByPlaceholder("Search clients with a registered wallet").fill("Jamie");
  await page.getByText("Jamie Rivera").click();
  await page.getByRole("button", {name: "Start"}).click();

  const link = page.getByTestId("delegation-add-link");
  await expect(link).toBeVisible({timeout: 10_000});
  const qr = await link.textContent();
  expect(qr).toBeTruthy();
  const token = new URL(qr!).pathname.split("/").pop()!;

  // The "phone half" - a genuinely independent client, API-driven exactly like
  // wallet-registration.spec.ts's own `/w/:token`/`/complete` calls.
  const challengeRes = await page.request.get(`/d/${token}`);
  expect(challengeRes.ok()).toBe(true);
  const challenge = (await challengeRes.json()) as Challenge;
  expect(challenge.dogTagIdField).toBe(dogTagIdField);
  expect(challenge.maskedTargetName).toMatch(/^J/); // masked "Jamie Rivera" - never the raw name

  const commitment = randomHex32();
  const claim = await signClaim(challenge, account, commitment);
  const completeRes = await page.request.post(`/d/${token}/complete`, {data: claim});
  expect(completeRes.ok()).toBe(true);

  // Staff status poll (2s interval) picks up "claimed" - the on-chain step button appears.
  const addOnChainButton = page.getByRole("button", {name: "Add on chain"});
  await expect(addOnChainButton).toBeVisible({timeout: 10_000});

  // Script the decisive confirm-time chain read BEFORE clicking, so it is already correct the
  // instant the app's own confirm poll fires - `isSecondary` is what `reconcileDelegationWrite`
  // actually decides on (see that module's own doc comment on why, not secondaryCount/root).
  // `delegationLeaves` is a SEPARATE read the Owners card's own display uses
  // (`ownersCardData.ts`) - scripted too, so the post-confirm `router.refresh()` shows this
  // commitment as active rather than falling back to the all-zero default.
  await setRpcScenario("isSecondary", DELEGATION_REGISTRY_ADDRESS, [dogTagIdField, commitment], true);
  await setRpcScenario("delegationLeaves", DELEGATION_REGISTRY_ADDRESS, [dogTagIdField], sixteenSlotLeaves(commitment));
  await addOnChainButton.click();

  await expect(page.getByText("Confirming on chain...")).toBeVisible({timeout: 10_000});

  // The mock wallet connector already answered eth_sendTransaction with a fake hash and the app
  // already posted it to `.../tx` - script THAT hash's receipt as mined-success so
  // `useWaitForTransactionReceipt` resolves and the app's own confirm call fires.
  const hash = await getLastSentTxHash();
  expect(hash).not.toBeNull();
  await setRpcReceipt(hash!, "success");

  await expect(page.getByText("Secondary owner added")).toBeVisible({timeout: 15_000});
  await expect(ownersCard(page).getByText("Jamie Rivera")).toBeVisible();
  await expect(ownersCard(page).getByText("Active")).toBeVisible();
});

test("Revoke a secondary owner: no QR, straight to the operator wallet write", async ({page}) => {
  const {petId, dogTagIdField, clientId} = await seedPetAndSecondaryClient();
  const commitment = randomHex32();

  // Seed the confirmed "add" this test revokes - the ceremony this suite's own first test already
  // covers end to end, so it is seeded directly here (mirrors mint-issue-revert.spec.ts's own
  // convention: seed the PRECONDITION state, test the STEP this test is actually about).
  await mongoClient.db().collection("delegationsessions").insertOne({
    token: randomUUID().replace(/-/g, "").slice(0, 32),
    registrationId: randomUUID(),
    kind: "add",
    petId,
    dogTagIdField,
    clientId,
    clinic: CLONE_ADDRESS.toLowerCase(),
    chainId: 135,
    clinicName: "Example Vet Clinic",
    maskedTargetName: "J***** R******",
    commitment: commitment.toLowerCase(),
    wallet: "0x1111111111111111111111111111111111111111",
    issuedAt: Math.floor(Date.now() / 1000) - 60,
    blockNumber: 1,
    deadline: Math.floor(Date.now() / 1000) + 600,
    status: "confirmed",
    consumed: true,
    consumedAt: Math.floor(Date.now() / 1000) - 60,
    createdAt: new Date(),
  });
  // Both reads the Owners card's own render needs to show this row as active (`delegationLeaves`)
  // and the one the confirm step's decisive check needs (`isSecondary`) - see the ADD test's
  // identical comment above.
  await setRpcScenario("isSecondary", DELEGATION_REGISTRY_ADDRESS, [dogTagIdField, commitment], true);
  await setRpcScenario("delegationLeaves", DELEGATION_REGISTRY_ADDRESS, [dogTagIdField], sixteenSlotLeaves(commitment));

  await page.goto(`/pets/${petId}`);
  await expect(ownersCard(page).getByText("Jamie Rivera")).toBeVisible();
  await expect(ownersCard(page).getByText("Active")).toBeVisible();

  await ownersCard(page).getByRole("button", {name: "Revoke"}).click();
  await ownersCard(page).getByRole("button", {name: /Confirm revoke/}).click();

  await expect(page.getByText("Revoking...")).toBeVisible({timeout: 10_000});

  // Unlike AddSecondaryOwnerAction's "Confirming on chain..." (which only renders once the wallet
  // write has already resolved), RevokeSecondaryOwnerAction's "Revoking..." badge covers its ENTIRE
  // remaining lifecycle starting the instant the ceremony session is created - well before
  // `writeContractAsync` is even called, let alone resolved. `expect.poll` (not a single read)
  // waits out that real, structural race instead of assuming the write already happened.
  await expect.poll(() => getLastSentTxHash(), {timeout: 10_000}).not.toBeNull();
  const hash = await getLastSentTxHash();
  expect(hash).not.toBeNull();
  // The decisive postcondition flips: isSecondary must now report false for this commitment, and
  // the Owners card's own display read (delegationLeaves) must no longer carry it either - the
  // real DelegationRegistry.revoke zeroes the slot in place.
  await setRpcScenario("isSecondary", DELEGATION_REGISTRY_ADDRESS, [dogTagIdField, commitment], false);
  await setRpcScenario("delegationLeaves", DELEGATION_REGISTRY_ADDRESS, [dogTagIdField], sixteenSlotLeaves());
  await setRpcReceipt(hash!, "success");

  await expect(page.getByText("Secondary owner revoked")).toBeVisible({timeout: 15_000});
  await expect(page.getByText("Revoked")).toBeVisible();
});
