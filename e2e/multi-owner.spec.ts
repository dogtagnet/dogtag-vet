import {expect, test, type Page} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {MongoClient} from "mongodb";
import {privateKeyToAccount, generatePrivateKey} from "viem/accounts";
import {buildMerkle, hashLeaf, hexToBytes, toHex32, TypeTag, verifyLeafCommitment, type OpenedLeaf, type TypedScalar} from "@dogtag/standard";
import {E2E_MONGO_URI} from "./mongo-fixture";
import {forceRpcSendTransactionFailure, getLastSentTxHash, resetRpcStub, setRpcReceipt, setRpcScenario} from "./rpcStub";

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

/** Every object key at every nesting depth, for the D3 no-owner-secret-material assertion below -
 * a plain top-level `Object.keys` would miss a leaked key nested inside `disclosed[]` or any future
 * bundle field this test does not otherwise name. */
function allKeysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeysDeep);
  if (value && typeof value === "object") {
    return Object.keys(value).flatMap((k) => [k, ...allKeysDeep((value as Record<string, unknown>)[k])]);
  }
  return [];
}

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

/**
 * WP4.17A D8 - actively samples how many `text` toasts are visible every 250ms for `durationMs`
 * (default 10s - comfortably longer than a snackbar's own 4000ms auto-dismiss window,
 * `Snackbar.tsx`'s literal `setTimeout(..., 4000)`, plus the slower of the two racing paths'
 * own worst-case detection latency) and fails the instant either (a) more than one is visible at
 * once, or (b) the count drops to zero after having been visible and then rises again - a SECOND,
 * separate toast with the same text, created by `Snackbar.tsx`'s own per-message `key={m.id}`,
 * that never happened to overlap the first's visible window is still the real bug (a clinic user
 * sees the message twice, just not simultaneously), and a bare "was the count ever above 1" check
 * cannot see it.
 *
 * A single point-in-time check (wait some fixed delay, then check the count once) is NOT a
 * reliable way to catch this class of bug: the poll branch and the receipt effect each toast on
 * their own independent timer (a 2s poll cadence vs. wagmi's own receipt-detection cadence), so
 * the two toasts' relative timing varies with exactly which awaited calls precede them - confirmed
 * empirically while writing this: a fixed 2.5s wait sometimes sampled BEFORE the second (buggy)
 * toast had appeared (a false pass); a fixed 6s wait sometimes sampled AFTER both had already
 * auto-dismissed (also a false pass, `Received: 0`); and even a first version of this function
 * that only checked "was the count ever >= 2" reliably caught the add ceremony's own double-toast
 * but never the revoke ceremony's, on the same guard-removed copy, across 4 consecutive runs -
 * because revoke's two toasts, in this repo's own RPC-stub timing, land back-to-back rather than
 * overlapping. Continuous sampling for a reappearance, across the whole risk window, is what
 * neither a fixed delay nor an overlap-only check could substitute for.
 */
async function assertToastNeverDoubles(page: Page, text: string, durationMs = 10_000): Promise<void> {
  const locator = page.getByText(text);
  const deadline = Date.now() + durationMs;
  let sawVisible = false;
  let sawGapAfterVisible = false;
  while (Date.now() < deadline) {
    const count = await locator.count();
    expect(count, `more than one "${text}" toast was visible at once`).toBeLessThanOrEqual(1);
    if (count >= 1) {
      expect(sawGapAfterVisible, `a second, separate "${text}" toast appeared after the first had already dismissed`).toBe(false);
      sawVisible = true;
    } else if (sawVisible) {
      sawGapAfterVisible = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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

/** Bumped on every `buildVerifiableProfile` call so each one folds to a genuinely DIFFERENT root -
 * `TagArtifact.root` carries a unique index (see that model's own schema), and this suite calls
 * `seedPetAndSecondaryClient` (every call builds a profile for the same fictional "Blaze") more
 * than once per file. Fixed salts alone (mirroring `tag-custody.spec.ts`'s own convention, which
 * gets away with it because its own calls vary `name` per test) would collide across THIS file's
 * multiple tests, which all use the identical "Blaze"/"dog" pair. Starting from `Date.now()` rather
 * than a fixed `0` also keeps a run from colliding with a DIFFERENT spec file's own hand-rolled
 * fixture (or a stale row from an earlier run of this exact file, if the e2e database were ever
 * not fully torn down) - `0` would silently reproduce the very first, most guessable root a
 * copy-pasted version of this same helper elsewhere might also produce. */
let profileNonce = Date.now() % 97;

/** A genuine (leaves, reservedLeafHashes, root) triple the real `verifyLeafCommitment` accepts -
 * mirrors `tag-custody.spec.ts`'s own `buildVerifiableProfile` (the "keep a separate copy"
 * convention this file's own header comment already follows for the EIP-712 types). Needed so the
 * co-owner bundle (grade round 1 D3) has a real `TagArtifact` to build from - a bundle recomputes
 * its own root via `verifyRedactedArtifact` and fails its self-check on anything less than genuine
 * crypto, unlike the rest of this suite's opaque, uninterpreted `commitment` values. */
function buildVerifiableProfile(name: string, species: string): {leaves: OpenedLeaf[]; reservedLeafHashes: string[]; root: string} {
  const nonce = profileNonce++;
  const salt = (n: number) => new Uint8Array(16).fill((n + nonce) % 256);
  const saltHexOf = (n: number) => ("0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
  const leaves: OpenedLeaf[] = [
    {keyPath: "credentialSubject.name", saltHex: saltHexOf(11), tag: TypeTag.String, value: name},
    {keyPath: "credentialSubject.species", saltHex: saltHexOf(12), tag: TypeTag.String, value: species},
  ];
  const reservedLeafHashes = [
    toHex32(hashLeaf("owner.address", salt(201), {tag: TypeTag.Bytes, value: new Uint8Array([1])} as TypedScalar)),
    toHex32(hashLeaf("owner.consentKey", salt(202), {tag: TypeTag.Bytes, value: new Uint8Array([2])} as TypedScalar)),
    toHex32(hashLeaf("owner.secret", salt(203), {tag: TypeTag.Bytes, value: new Uint8Array([3])} as TypedScalar)),
  ];
  const reservedFields = reservedLeafHashes.map((h) => BigInt(h));
  const leafFields = leaves.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), {tag: l.tag, value: l.value} as TypedScalar));
  const root = toHex32(buildMerkle([...reservedFields, ...leafFields]).root);
  expect(verifyLeafCommitment({root, leaves, reservedLeafHashes, expectedIdentityLeaves: []})).toBe(true);
  return {leaves, reservedLeafHashes, root};
}

/** A pet with an issued tag AND a custodied `TagArtifact` (grade round 1 D3 - the co-owner bundle
 * is built from exactly this record, `status/route.ts`'s `tryBuildBundle`), plus a client with a
 * registered wallet ready to become a secondary owner - the three preconditions the ceremony's own
 * start route and the post-confirm bundle both need (`docs/DELEGATION.md` section 4.3). Raw
 * `insertOne`s (mirroring `mint-issue-revert.spec.ts`'s own convention) - this suite is not testing
 * issuance or wallet registration, both of which have their own coverage. */
/** `secondaryName` (WP4.19 V5) - defaults to "Jamie Rivera" (byte-identical default behavior for
 * every pre-existing caller); a test that ALSO drives the client-search combobox (which this
 * file's own first test already does) and runs after another such test in this same serial suite
 * needs its own distinct name, since every call creates ANOTHER row and the combobox has no other
 * way to disambiguate two identically-named, contact-info-free clients. */
async function seedPetAndSecondaryClient(secondaryName = "Jamie Rivera"): Promise<{
  petId: string;
  dogTagIdField: string;
  clientId: string;
  account: ReturnType<typeof privateKeyToAccount>;
  artifact: ReturnType<typeof buildVerifiableProfile>;
}> {
  const petId = randomUUID();
  const dogTagIdField = String(Math.floor(Math.random() * 1_000_000) + 1);
  const artifact = buildVerifiableProfile("Blaze", "dog");
  await mongoClient.db().collection("pets").insertOne({
    petId,
    name: "Blaze",
    microchip: {},
    weightHistory: [],
    ownerClientIds: [],
    primaryOwnerClientId: undefined,
    dogTag: {dogTagIdDec: dogTagIdField, dogTagIdField, root: artifact.root.toLowerCase(), status: "active", cloneAddress: CLONE_ADDRESS},
    searchKey: "blaze",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const artifactInsert = await mongoClient.db().collection("tagartifacts").insertOne({
    artifactId: `e2e-${petId}`,
    petId,
    dogTagIdDec: dogTagIdField,
    dogTagIdField,
    root: artifact.root.toLowerCase(),
    protocolVersion: "dogtag-v2/1",
    leaves: artifact.leaves,
    reservedLeafHashes: artifact.reservedLeafHashes,
    source: "issued_here",
    issuerClone: CLONE_ADDRESS,
    verifiedAt: Math.floor(Date.now() / 1000),
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // "Assert the artifact exists first, then assert the bundle" (grade round 1 D3's own recipe) - a
  // fixture that failed to land must fail HERE, loudly and specifically, not surface later as a
  // confusing bundle-shape mismatch that sends a future fixer chasing the wrong thing.
  expect(artifactInsert.acknowledged).toBe(true);

  const account = privateKeyToAccount(generatePrivateKey());
  const clientId = randomUUID();
  await mongoClient.db().collection("clients").insertOne({
    clientId,
    name: secondaryName,
    petIds: [],
    wallets: [{address: account.address.toLowerCase(), registeredAt: Math.floor(Date.now() / 1000)}],
    searchKey: secondaryName.toLowerCase(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return {petId, dogTagIdField, clientId, account, artifact};
}

test("Add secondary owner: full ceremony from the Owners card through on-chain confirmation", async ({page}) => {
  const {petId, dogTagIdField, account, artifact} = await seedPetAndSecondaryClient();

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
  // WP4.17A D8 - the 2s staff poll and the wagmi receipt effect both used to toast independently
  // on the same confirmed session; whichever fires first makes the assertion above pass either
  // way, so the real proof is that the OTHER one never ALSO adds a second toast. See
  // `assertToastNeverDoubles`'s own doc comment for why continuous sampling, not a fixed wait
  // plus one count check, is what this actually needs.
  await assertToastNeverDoubles(page, "Secondary owner added");
  await expect(ownersCard(page).getByText("Jamie Rivera")).toBeVisible();
  await expect(ownersCard(page).getByText("Active")).toBeVisible();

  // Grade round 1 D3: assert the co-owner bundle itself, on the wire. Plan section 14.1 item V6's
  // own e2e arc ends "... -> Owners card updates -> bundle served" - nothing before this fix round
  // ever called this endpoint or looked at its response body, so a real fault in `tryBuildBundle`
  // (status/route.ts) had zero coverage at any level.
  const statusRes = await page.request.get(`/d/${token}/status`);
  expect(statusRes.ok()).toBe(true);
  const statusBody = await statusRes.json();
  expect(statusBody.status).toBe("added");
  // Not `bundleUnavailable` - the TagArtifact this test seeded (and already asserted landed, in
  // seedPetAndSecondaryClient) must have produced a real bundle, not a silent miss.
  expect(statusBody.bundleUnavailable).toBeUndefined();
  const bundle = statusBody.bundle as Record<string, unknown>;
  expect(bundle).toBeTruthy();

  const REQUIRED_BUNDLE_FIELDS = [
    "protocolVersion",
    "dogTagIdField",
    "root",
    "disclosed",
    "obfuscatedLeafHashes",
    "reservedLeafHashes",
    "delegationLeaves",
    "issuerClone",
    "chainId",
    "petName",
    "clinicName",
  ] as const; // DelegationCoOwnerBundle.required, verbatim - 11 fields.
  for (const field of REQUIRED_BUNDLE_FIELDS) {
    expect(bundle, `bundle.${field} must be present`).toHaveProperty(field);
  }
  expect(bundle.dogTagIdField).toBe(dogTagIdField);
  expect((bundle.root as string).toLowerCase()).toBe(artifact.root.toLowerCase());
  expect(bundle.delegationLeaves).toHaveLength(16);
  expect((bundle.delegationLeaves as string[])[0]!.toLowerCase()).toBe(commitment.toLowerCase());
  expect(bundle.reservedLeafHashes).toHaveLength(3);
  expect(bundle.petName).toBe("Blaze");
  expect(bundle.clinicName).toBe("Example Vet Clinic");

  // No owner-secret material anywhere in the bundle, at any nesting depth - true by construction
  // (`DelegationCoOwnerBundle`'s own TS interface declares no such field at all), re-checked here
  // on the actual wire response rather than merely trusted from reading the type.
  const forbidden = /ownersecret|consentkey|seed|ownersalt|secretsalt/i;
  for (const key of allKeysDeep(bundle)) {
    expect(key, `bundle must not carry a "${key}" key`).not.toMatch(forbidden);
  }
});

/**
 * WP4.19 V5 - the reverted-receipt gap the 2026-09-25 incident fix disclosed but did not fix in
 * this component (`TagIssueWizard.tsx`'s own fix-round-2 doc comment names AddSecondaryOwnerAction
 * explicitly as one of five sibling gaps "recorded here as a ticket for a future wave"). Reproduced
 * first (as the coordinator's own instruction requires): before this fix, scripting the receipt
 * "reverted" here left the panel stuck on the bare `StatusBadge tone="info" label="Confirming on
 * chain..."` forever - `useWaitForTransactionReceipt` never resolves `isSuccess` for a REVERTED
 * receipt (it throws internally, surfacing as `isError` instead), and the pre-fix effect only ever
 * fired on `isSuccess`. This test proves the FIXED behavior: a "Transaction failed" banner with the
 * dead tx hash kept for the record, and a working "Start over" retry path.
 */
test("Add secondary owner: a REVERTED receipt (status 0x0) shows Transaction failed with the kept hash, not a stuck 'Confirming on chain...' forever", async ({page}) => {
  // A distinct name (not the default "Jamie Rivera") - this file's own first test already seeded
  // one "Jamie Rivera" by the time this test runs (shared Mongo, serial suite), and neither client
  // carries an email/phone to otherwise disambiguate two identically-named combobox results.
  const {petId, dogTagIdField, account} = await seedPetAndSecondaryClient("Priya Lindqvist");

  await page.goto(`/pets/${petId}`);
  await expect(ownersCard(page).getByRole("heading", {name: "DogTag owners"})).toBeVisible();

  await page.getByRole("button", {name: "Add secondary owner"}).click();
  await page.getByPlaceholder("Search clients with a registered wallet").fill("Priya");
  await page.getByText("Priya Lindqvist").click();
  await page.getByRole("button", {name: "Start"}).click();

  const link = page.getByTestId("delegation-add-link");
  await expect(link).toBeVisible({timeout: 10_000});
  const qr = await link.textContent();
  const token = new URL(qr!).pathname.split("/").pop()!;

  const challengeRes = await page.request.get(`/d/${token}`);
  expect(challengeRes.ok()).toBe(true);
  const challenge = (await challengeRes.json()) as Challenge;
  const commitment = randomHex32();
  const claim = await signClaim(challenge, account, commitment);
  const completeRes = await page.request.post(`/d/${token}/complete`, {data: claim});
  expect(completeRes.ok()).toBe(true);

  const addOnChainButton = page.getByRole("button", {name: "Add on chain"});
  await expect(addOnChainButton).toBeVisible({timeout: 10_000});

  // `isSecondary` scripted false (the honest, correct answer for a write that never actually
  // landed) - `reconcileDelegationWrite`'s own decisive check, so the confirm route agrees this
  // never happened, exactly matching what a real reverted `addSecondaryOwner` would leave on chain.
  await setRpcScenario("isSecondary", DELEGATION_REGISTRY_ADDRESS, [dogTagIdField, commitment], false);
  await addOnChainButton.click();
  await expect(page.getByText("Confirming on chain...")).toBeVisible({timeout: 10_000});

  const hash = await getLastSentTxHash();
  expect(hash).not.toBeNull();
  await setRpcReceipt(hash!, "reverted"); // status 0x0

  await expect(page.getByRole("status").filter({hasText: "Transaction failed"})).toBeVisible({timeout: 15_000});
  await expect(page.getByText("Confirming on chain...")).toHaveCount(0);
  // The dead tx hash is kept for the record, not silently dropped - HashCell truncates to
  // `value.slice(0, 6)`...`value.slice(-4)` (MonoValue.tsx's own default prefix/suffix), so the
  // truncated prefix is what actually appears in the DOM.
  await expect(page.getByText(hash!.slice(0, 6), {exact: false})).toBeVisible();

  // The retry path: "Start over" clears the failed ceremony session (never the picked client) and
  // returns to the "Start" button for the SAME already-selected client - a working way back, not
  // a dead end.
  await page.getByRole("button", {name: "Start over"}).click();
  await expect(page.getByText("Priya Lindqvist")).toBeVisible();
  await expect(page.getByRole("button", {name: "Start"})).toBeVisible();
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
  // WP4.17A D8 - the revoke twin of the add ceremony's identical assertion above.
  await assertToastNeverDoubles(page, "Secondary owner revoked");
  // Scoped to the card, like the add test's own "Active" check above - a bare page-level
  // `getByText("Revoked")` also matches this toast's own text ("Secondary owner revoked",
  // case-insensitive substring match), which is exactly the kind of ambiguity this file's other
  // status-badge checks are already careful to avoid.
  await expect(ownersCard(page).getByText("Revoked", {exact: true})).toBeVisible();
});

test("Revoke a secondary owner: a rejected wallet prompt returns the row to idle, not a permanent 'Revoking...' badge", async ({page}) => {
  // Grade round 1 D6: before this fix, `registrationId` being set immediately (well before
  // `writeContractAsync` even runs) meant a rejected wallet prompt left this component showing
  // ONLY a "Revoking..." badge forever - no button, no recovery, a reload required. This test
  // fails on the pre-fix code (the "Revoke" button never reappears) and passes once
  // `RevokeSecondaryOwnerAction`'s catch resets `registrationId`/`pendingTxHash` and stops polling.
  const {petId, dogTagIdField, clientId} = await seedPetAndSecondaryClient();
  const commitment = randomHex32();

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
  await setRpcScenario("isSecondary", DELEGATION_REGISTRY_ADDRESS, [dogTagIdField, commitment], true);
  await setRpcScenario("delegationLeaves", DELEGATION_REGISTRY_ADDRESS, [dogTagIdField], sixteenSlotLeaves(commitment));

  await page.goto(`/pets/${petId}`);
  await expect(ownersCard(page).getByText("Jamie Rivera")).toBeVisible();
  await expect(ownersCard(page).getByText("Active")).toBeVisible();

  await forceRpcSendTransactionFailure();
  await ownersCard(page).getByRole("button", {name: "Revoke"}).click();
  await ownersCard(page).getByRole("button", {name: /Confirm revoke/}).click();

  // The row must come back to life - never stay on "Revoking..." with no way out.
  await expect(ownersCard(page).getByRole("button", {name: "Revoke"})).toBeVisible({timeout: 10_000});
  await expect(page.getByText("Revoking...")).toHaveCount(0);

  // The coordinator's own fix-round instruction: idle "with an inline error", not merely idle -
  // a transient snackbar alone is easy to miss and leaves nothing on the row explaining why
  // "Revoke" reappeared. Not pinning exact text (wagmi/viem's own error formatting for a
  // simulated RPC rejection is verbose and not this test's concern) - only that a real, non-empty
  // message rendered on the row itself.
  const inlineError = ownersCard(page).getByTestId("revoke-inline-error");
  await expect(inlineError).toBeVisible();
  expect((await inlineError.textContent())?.trim().length).toBeGreaterThan(0);

  // Proves this is a real return to idle, not a coincidental re-render: the SAME real write,
  // retried, still succeeds cleanly (the one-shot failure already reset itself on the stub).
  await ownersCard(page).getByRole("button", {name: "Revoke"}).click();
  await ownersCard(page).getByRole("button", {name: /Confirm revoke/}).click();
  await expect.poll(() => getLastSentTxHash(), {timeout: 10_000}).not.toBeNull();
  const hash = await getLastSentTxHash();
  expect(hash).not.toBeNull();
  await setRpcScenario("isSecondary", DELEGATION_REGISTRY_ADDRESS, [dogTagIdField, commitment], false);
  await setRpcScenario("delegationLeaves", DELEGATION_REGISTRY_ADDRESS, [dogTagIdField], sixteenSlotLeaves());
  await setRpcReceipt(hash!, "success");
  await expect(page.getByText("Secondary owner revoked")).toBeVisible({timeout: 15_000});
  // WP4.17A D8 - same guard proof as the primary revoke test above: this retry path goes through
  // the identical poll/receipt race once it succeeds.
  await assertToastNeverDoubles(page, "Secondary owner revoked");
});
