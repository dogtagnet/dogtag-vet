import {expect, test, type Page} from "@playwright/test";
import {
  buildMerkle,
  dogTagIdField,
  hashLeaf,
  hexToBytes,
  toHex32,
  TypeTag,
  verifyLeafCommitment,
  verifyRedactedArtifact,
  type OpenedLeaf,
  type TypedScalar,
} from "@dogtag/standard";
import {setRpcScenario, resetRpcStub} from "./rpcStub";

/**
 * End-to-end coverage for plans/wp4.9-tag-data-custody.md sections 2.2 (export) and 2.3 (import) -
 * checklist item 7. Proves, against a real running app (not just the flow-level unit tests and
 * real-ephemeral-mongod integration tests already in tests/unit/): the export ceremony's single-use
 * exhaustion, the import ceremony's chain-verified happy path with UI-visible attachment, the
 * revoked-at-issuer refusal, and the fill-empty-only conflict banner - each also forces the first
 * cold client webpack build of PetTagCard's new composition (Banner + ShareTagDataAction +
 * ImportTagAction, all "use client" leaves under a server component), the exact class of build-time
 * hazard WP4.7A's own node:crypto incident documents (no e2e run had touched these files before now).
 */

const SBT_ADDRESS = "0x276101555b2cd92be0fb85ff908e02281d6a3cf9";
const FACTORY_ADDRESS = "0x1bd279d3c9fc85eb3e4d304ee890435b6a5ca4cc";
const OUR_CLONE = "0x7b9bf16f0e39adf8c38d8491f4c7e9c17e85d703"; // configureClinic's own cloneAddress
const FOREIGN_CLONE = `0x${"ee".repeat(20)}`;

async function signInAsStaff(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", {name: "Dev sign in (test only)"}).click();
  await expect(page).toHaveURL(/\/dashboard$/, {timeout: 15_000});
}

/** Idempotent, mirrors mobile-booking.spec.ts's own configureClinic. */
async function configureClinic(page: Page) {
  const res = await page.request.patch("/api/settings", {
    data: {cloneAddress: OUR_CLONE, businessProfile: {name: "Example Vet Clinic"}},
  });
  expect(res.ok()).toBe(true);
}

async function createClientApi(page: Page, name: string, email: string): Promise<string> {
  const res = await page.request.post("/api/clients", {data: {name, email}});
  expect(res.ok()).toBe(true);
  return (await res.json()).clientId as string;
}

/** `POST /api/pets` requires at least one owner (`createPetSchema`'s own `ownerClientIds.min(1)`) -
 * creates a throwaway client first, uniquely named/emailed per call so no two calls in this file
 * ever collide. */
let nextPetOwnerSeq = 1;
async function createPetApi(page: Page, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const n = nextPetOwnerSeq++;
  const clientId = await createClientApi(page, `Owner ${n}`, `tag-custody-owner-${n}@example.com`);
  const res = await page.request.post("/api/pets", {data: {name, ownerClientIds: [clientId], ...extra}});
  expect(res.ok()).toBe(true);
  return (await res.json()).petId as string;
}

/** A genuine (leaves, reservedLeafHashes, root) triple the real `verifyLeafCommitment` accepts -
 * mirrors mobile-booking.spec.ts's own `buildVerifiablePetProfile`, extended with a name leaf
 * (needed here for the fill-empty/conflict merge tests, which mobile-booking's own version has no
 * use for). */
function buildVerifiableProfile(name: string, species: string): {leaves: OpenedLeaf[]; reservedLeafHashes: string[]; root: string} {
  const salt = (n: number) => new Uint8Array(16).fill(n);
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

/** Seeds a pet with an ALREADY-CUSTODIED active tag - a real Pet.dogTag plus a matching TagArtifact
 * row, exactly what the export ceremony reads from. There is no staff UI to create a TagArtifact
 * from scratch outside the mint/import flows, so this reaches into Mongo directly, mirroring
 * mobile-booking.spec.ts's `seedLocalDogTag`/`seedClientWallet` escape hatch for state no API
 * exposes. Export never re-verifies at read time (verify-at-write already happened), so the
 * leaves/root only need to be well-formed, not independently re-checked here - built with real
 * crypto anyway for realism. */
async function seedCustodiedPet(page: Page, petId: string, dogTagIdDec: string, fixture: ReturnType<typeof buildVerifiableProfile>) {
  const {MongoClient} = await import("mongodb");
  const {E2E_MONGO_URI} = await import("./mongo-fixture");
  const client = new MongoClient(E2E_MONGO_URI);
  await client.connect();
  try {
    const dogTagIdFieldDec = dogTagIdField(dogTagIdDec).toString(10);
    await client.db().collection("pets").updateOne(
      {petId},
      {
        $set: {
          dogTag: {
            dogTagIdDec,
            dogTagIdField: dogTagIdFieldDec,
            root: fixture.root.toLowerCase(),
            status: "active",
            cloneAddress: OUR_CLONE,
          },
        },
      },
    );
    await client.db().collection("tagartifacts").insertOne({
      artifactId: `e2e-${petId}`,
      petId,
      dogTagIdDec,
      dogTagIdField: dogTagIdFieldDec,
      root: fixture.root.toLowerCase(),
      protocolVersion: "dogtag-v2/1",
      leaves: fixture.leaves,
      reservedLeafHashes: fixture.reservedLeafHashes,
      source: "issued_here",
      issuerClone: OUR_CLONE,
      verifiedAt: Math.floor(Date.now() / 1000),
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } finally {
    await client.close();
  }
  void page;
}

async function createImportSession(page: Page, targetPetId?: string): Promise<{token: string; qr: string}> {
  const res = await page.request.post("/api/tags/import-sessions", {data: {targetPetId}});
  expect(res.ok()).toBe(true);
  return res.json();
}

test.beforeEach(async ({page}) => {
  await signInAsStaff(page);
  await configureClinic(page);
  await resetRpcStub();
});

test.describe("export ceremony (plan 2.2)", () => {
  test("staff clicks Share on the pet page, the QR resolves once with the full leaf set, and a second fetch is 410", async ({page}) => {
    const petId = await createPetApi(page, "Rex");
    const fixture = buildVerifiableProfile("Rex", "dog");
    await seedCustodiedPet(page, petId, "70001", fixture);

    // UI walkthrough - forces the cold client build of PetTagCard's new composition.
    await page.goto(`/pets/${petId}`);
    await page.getByRole("button", {name: "Share tag data to owner's phone"}).click();
    await expect(page.getByText("Scan with the owner's DogTag app")).toBeVisible({timeout: 15_000}); // POST + client QR render can outrun the 5s default under load
    const link = page.getByTestId("export-tag-data-link");
    const qrUrl = await link.textContent();
    expect(qrUrl).toContain("/e/");

    const first = await page.request.get(qrUrl!);
    expect(first.status()).toBe(200);
    const body = await first.json();
    expect(body.protocolVersion).toBe("dogtag-v2/1");
    expect(body.dogTagIdDec).toBe("70001");
    // WP4.10V item 3: the response is now literally a RedactedTagArtifact (plans/
    // wp4.10-masked-export.md section 2); a fully-disclosed export (no mask picked here) is that
    // format's degenerate case, obfuscatedLeafHashes empty. `leaves` is a DEPRECATED alias of
    // `disclosed` kept for WP4.9M's shipped phone client (orchestrator ruling, P2 finding) - both
    // must carry IDENTICAL content, not just `disclosed` alone.
    expect(body.disclosed).toEqual(fixture.leaves);
    expect(body.leaves).toEqual(fixture.leaves);
    expect(body.obfuscatedLeafHashes).toEqual([]);
    expect(body.reservedLeafHashes).toEqual(fixture.reservedLeafHashes);
    expect(body.issuerClone).toBe(OUR_CLONE);
    expect(body.petName).toBe("Rex");
    expect(body.clinicName).toBe("Example Vet Clinic");

    // Single-use exhaustion: the SAME token, fetched again, is 410 - asserting the FIRST call's
    // own success above, never a retry's code, is what actually proves one-time-use.
    const second = await page.request.get(qrUrl!);
    expect(second.status()).toBe(410);
    expect((await second.json()).error.code).toBe("expired_or_reused");
  });

  test("refuses to even generate a code for a pet with no tag data yet", async ({page}) => {
    const petId = await createPetApi(page, "Untagged");
    const res = await page.request.post(`/api/pets/${petId}/export-tag-data`);
    expect(res.status()).toBe(400);
  });

  test("WP4.10V item 7: staff picks 2 fields on 'Export with masking', and the resulting artifact carries exactly those 2 as obfuscated hashes and verifies", async ({page}) => {
    const petId = await createPetApi(page, "Shadow");
    // THREE disclosed leaves (not `buildVerifiableProfile`'s usual two) so masking exactly 2 of
    // them exercises the MIXED disclosed/obfuscated path through /e/:token - a name stays
    // disclosed, species+breed are masked. The fully-masked degenerate case (disclosed: []) is
    // already covered separately by exportFlow.test.ts's own "masking every leaf" unit test.
    const salt = (n: number) => new Uint8Array(16).fill(n);
    const saltHexOf = (n: number) => ("0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
    const nameLeaf: OpenedLeaf = {keyPath: "credentialSubject.name", saltHex: saltHexOf(11), tag: TypeTag.String, value: "Shadow"};
    const speciesLeaf: OpenedLeaf = {keyPath: "credentialSubject.species", saltHex: saltHexOf(12), tag: TypeTag.String, value: "dog"};
    const breedLeaf: OpenedLeaf = {keyPath: "credentialSubject.breed", saltHex: saltHexOf(13), tag: TypeTag.String, value: "Whippet"};
    const leaves = [nameLeaf, speciesLeaf, breedLeaf];
    const reservedLeafHashes = [
      toHex32(hashLeaf("owner.address", salt(201), {tag: TypeTag.Bytes, value: new Uint8Array([1])} as TypedScalar)),
      toHex32(hashLeaf("owner.consentKey", salt(202), {tag: TypeTag.Bytes, value: new Uint8Array([2])} as TypedScalar)),
      toHex32(hashLeaf("owner.secret", salt(203), {tag: TypeTag.Bytes, value: new Uint8Array([3])} as TypedScalar)),
    ];
    const reservedFields = reservedLeafHashes.map((h) => BigInt(h));
    const leafFields = leaves.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), {tag: l.tag, value: l.value} as TypedScalar));
    const root = toHex32(buildMerkle([...reservedFields, ...leafFields]).root);
    expect(verifyLeafCommitment({root, leaves, reservedLeafHashes, expectedIdentityLeaves: []})).toBe(true);
    await seedCustodiedPet(page, petId, "70009", {leaves, reservedLeafHashes, root});

    // UI walkthrough - forces the first cold client build of MaskedExportPanel's composition.
    await page.goto(`/pets/${petId}`);
    await page.getByRole("button", {name: "Export with masking"}).click();
    // /export-tag-data/fields fetch + render can outrun the 5s default under load.
    await expect(page.getByRole("checkbox")).toHaveCount(3, {timeout: 15_000});

    // Mask exactly 2 of the 3 disclosed leaves - name stays disclosed.
    await page.locator("li", {hasText: "credentialSubject.species"}).getByRole("checkbox").check();
    await page.locator("li", {hasText: "credentialSubject.breed"}).getByRole("checkbox").check();

    await page.getByRole("button", {name: "Show QR"}).click();
    await expect(page.getByText("Scan with the owner's DogTag app")).toBeVisible({timeout: 15_000});
    const link = page.getByTestId("masked-export-link");
    const qrUrl = await link.textContent();
    expect(qrUrl).toContain("/e/");

    const res = await page.request.get(qrUrl!);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.disclosed).toEqual([nameLeaf]);
    expect(body.leaves).toEqual([nameLeaf]); // the deprecated alias mirrors disclosed exactly
    const expectedHashes = [speciesLeaf, breedLeaf]
      .map((l) => toHex32(hashLeaf(l.keyPath, hexToBytes(l.saltHex), {tag: l.tag, value: l.value} as TypedScalar)))
      .sort();
    expect(body.obfuscatedLeafHashes).toHaveLength(2);
    expect([...body.obfuscatedLeafHashes].sort()).toEqual(expectedHashes);
    expect(body.reservedLeafHashes).toEqual(reservedLeafHashes);

    // The falsifiable "verifies" proof this checklist item asks for - real crypto against the
    // ACTUAL server response, never a shape assertion standing in for it.
    expect(
      verifyRedactedArtifact({
        protocolVersion: body.protocolVersion,
        dogTagIdField: body.dogTagIdField,
        root: body.root,
        disclosed: body.disclosed,
        obfuscatedLeafHashes: body.obfuscatedLeafHashes,
        reservedLeafHashes: body.reservedLeafHashes,
        issuerClone: body.issuerClone,
      }),
    ).toBe(true);
  });
});

test.describe("import ceremony (plan 2.3)", () => {
  test("happy path onto an existing pet: verified on chain, attached, visible on the pet page", async ({page}) => {
    const targetPetId = await createPetApi(page, "Buddy");
    const dogTagIdDec = "70002";
    const fieldDec = dogTagIdField(dogTagIdDec).toString(10);
    const fixture = buildVerifiableProfile("Buddy", "dog");
    await setRpcScenario("profileRoot", SBT_ADDRESS, [fieldDec], fixture.root);
    await setRpcScenario("rootIssuer", FACTORY_ADDRESS, [fixture.root], FOREIGN_CLONE);
    await setRpcScenario("isValid", FOREIGN_CLONE, [fixture.root], true);

    const session = await createImportSession(page, targetPetId);
    const resolve = await page.request.get(`/i/${session.token}`);
    expect(resolve.ok()).toBe(true);
    const resolveBody = await resolve.json();
    expect(resolveBody).toMatchObject({clinicName: "Example Vet Clinic", isNewPet: false, targetPetName: "Buddy"});

    const complete = await page.request.post(`/i/${session.token}/complete`, {
      data: {dogTagIdDec, leaves: fixture.leaves, reservedLeafHashes: fixture.reservedLeafHashes},
    });
    expect(complete.status()).toBe(200);
    const completeBody = await complete.json();
    expect(completeBody).toMatchObject({ok: true, petId: targetPetId, petName: "Buddy", created: false, conflicts: []});

    await page.goto(`/pets/${targetPetId}`);
    await expect(page.getByText("70002")).toBeVisible();
    await expect(page.getByText("External")).toBeVisible();

    // One-time semantics: the same token cannot complete twice.
    const replay = await page.request.post(`/i/${session.token}/complete`, {
      data: {dogTagIdDec, leaves: fixture.leaves, reservedLeafHashes: fixture.reservedLeafHashes},
    });
    expect(replay.status()).toBe(410);
  });

  test("no target: creates a brand-new pet from verified data", async ({page}) => {
    const dogTagIdDec = "70003";
    const fieldDec = dogTagIdField(dogTagIdDec).toString(10);
    const fixture = buildVerifiableProfile("Milo", "cat");
    await setRpcScenario("profileRoot", SBT_ADDRESS, [fieldDec], fixture.root);
    await setRpcScenario("rootIssuer", FACTORY_ADDRESS, [fixture.root], FOREIGN_CLONE);
    await setRpcScenario("isValid", FOREIGN_CLONE, [fixture.root], true);

    const session = await createImportSession(page); // no targetPetId
    const complete = await page.request.post(`/i/${session.token}/complete`, {
      data: {dogTagIdDec, leaves: fixture.leaves, reservedLeafHashes: fixture.reservedLeafHashes},
    });
    expect(complete.status()).toBe(200);
    const body = await complete.json();
    expect(body).toMatchObject({ok: true, created: true, petName: "Milo"});

    const petRes = await page.request.get(`/api/pets/${body.petId}`);
    const pet = await petRes.json();
    expect(pet.species).toBe("cat");
    expect(pet.dogTag.external).toBe(true);
  });

  test("revoked at the issuer: refuses with the exact code, and the target pet is left untouched", async ({page}) => {
    const targetPetId = await createPetApi(page, "Daisy");
    const dogTagIdDec = "70004";
    const fieldDec = dogTagIdField(dogTagIdDec).toString(10);
    const fixture = buildVerifiableProfile("Daisy", "dog");
    await setRpcScenario("profileRoot", SBT_ADDRESS, [fieldDec], fixture.root);
    await setRpcScenario("rootIssuer", FACTORY_ADDRESS, [fixture.root], FOREIGN_CLONE);
    await setRpcScenario("isValid", FOREIGN_CLONE, [fixture.root], false); // revoked at the issuer

    const session = await createImportSession(page, targetPetId);
    const complete = await page.request.post(`/i/${session.token}/complete`, {
      data: {dogTagIdDec, leaves: fixture.leaves, reservedLeafHashes: fixture.reservedLeafHashes},
    });
    expect(complete.status()).toBe(409);
    expect((await complete.json()).error.code).toBe("revoked");

    const petRes = await page.request.get(`/api/pets/${targetPetId}`);
    const pet = await petRes.json();
    expect(pet.dogTag?.dogTagIdDec).toBeUndefined();
  });

  test("verify_failed when the submitted leaves do not recompute the on-chain root", async ({page}) => {
    const targetPetId = await createPetApi(page, "Tampered");
    const dogTagIdDec = "70005";
    const fieldDec = dogTagIdField(dogTagIdDec).toString(10);
    const fixture = buildVerifiableProfile("Tampered", "dog");
    await setRpcScenario("profileRoot", SBT_ADDRESS, [fieldDec], fixture.root);
    await setRpcScenario("rootIssuer", FACTORY_ADDRESS, [fixture.root], FOREIGN_CLONE);
    await setRpcScenario("isValid", FOREIGN_CLONE, [fixture.root], true);
    const tamperedLeaves = fixture.leaves.map((l) => (l.keyPath === "credentialSubject.name" ? {...l, value: "NOT-REAL"} : l));

    const session = await createImportSession(page, targetPetId);
    const complete = await page.request.post(`/i/${session.token}/complete`, {
      data: {dogTagIdDec, leaves: tamperedLeaves, reservedLeafHashes: fixture.reservedLeafHashes},
    });
    expect(complete.status()).toBe(409);
    expect((await complete.json()).error.code).toBe("verify_failed");
  });

  test("conflict banner: an existing value that disagrees with the verified claim is kept, surfaced, and visible on the pet page", async ({page}) => {
    const targetPetId = await createPetApi(page, "Whiskers", {species: "cat"});
    const dogTagIdDec = "70006";
    const fieldDec = dogTagIdField(dogTagIdDec).toString(10);
    const fixture = buildVerifiableProfile("Whiskers", "dog"); // verified species "dog" conflicts with the pet's own "cat"
    await setRpcScenario("profileRoot", SBT_ADDRESS, [fieldDec], fixture.root);
    await setRpcScenario("rootIssuer", FACTORY_ADDRESS, [fixture.root], FOREIGN_CLONE);
    await setRpcScenario("isValid", FOREIGN_CLONE, [fixture.root], true);

    const session = await createImportSession(page, targetPetId);
    const complete = await page.request.post(`/i/${session.token}/complete`, {
      data: {dogTagIdDec, leaves: fixture.leaves, reservedLeafHashes: fixture.reservedLeafHashes},
    });
    expect(complete.status()).toBe(200);
    const body = await complete.json();
    expect(body.conflicts).toEqual([{field: "species", petValue: "cat", verifiedValue: "dog"}]);

    const petRes = await page.request.get(`/api/pets/${targetPetId}`);
    const pet = await petRes.json();
    expect(pet.species).toBe("cat"); // never overwritten

    await page.goto(`/pets/${targetPetId}`);
    await expect(page.getByText("Data mismatch at import time")).toBeVisible();
    await expect(page.getByText(/species/)).toBeVisible();
  });

  test("WP4.10V item 7: importing a masked (WP4.10M-shaped) artifact stores honest partial custody, visible as 'masked by the owner' on the pet page", async ({page}) => {
    const targetPetId = await createPetApi(page, "Pepper");
    const dogTagIdDec = "70012";
    const fieldDec = dogTagIdField(dogTagIdDec).toString(10);
    const fixture = buildVerifiableProfile("Pepper", "dog");
    const [nameLeaf, speciesLeaf] = fixture.leaves;
    const maskedHash = toHex32(hashLeaf(speciesLeaf!.keyPath, hexToBytes(speciesLeaf!.saltHex), {tag: speciesLeaf!.tag, value: speciesLeaf!.value} as TypedScalar));
    await setRpcScenario("profileRoot", SBT_ADDRESS, [fieldDec], fixture.root);
    await setRpcScenario("rootIssuer", FACTORY_ADDRESS, [fixture.root], FOREIGN_CLONE);
    await setRpcScenario("isValid", FOREIGN_CLONE, [fixture.root], true);

    const session = await createImportSession(page, targetPetId);
    const complete = await page.request.post(`/i/${session.token}/complete`, {
      data: {
        dogTagIdDec,
        disclosed: [nameLeaf],
        obfuscatedLeafHashes: [maskedHash],
        reservedLeafHashes: fixture.reservedLeafHashes,
      },
    });
    expect(complete.status()).toBe(200);
    const body = await complete.json();
    expect(body).toMatchObject({ok: true, petId: targetPetId, petName: "Pepper", created: false});

    // Honest partial custody: species was never disclosed to this clinic, only its hash - the pet
    // page shows a COUNT banner, never invents the masked value.
    await page.goto(`/pets/${targetPetId}`);
    await expect(page.getByText("Some fields are masked by the owner")).toBeVisible();
    await expect(page.getByText("1 attribute on this tag was masked")).toBeVisible();

    const petRes = await page.request.get(`/api/pets/${targetPetId}`);
    const pet = await petRes.json();
    expect(pet.species).toBeUndefined(); // never filled in from a value this clinic does not have
  });

  test("already_has_active_tag: refuses onto a target that already has one, with no change to it", async ({page}) => {
    const targetPetId = await createPetApi(page, "Already Tagged");
    const existing = buildVerifiableProfile("Already Tagged", "dog");
    await seedCustodiedPet(page, targetPetId, "70007", existing);

    const res = await page.request.post("/api/tags/import-sessions", {data: {targetPetId}});
    expect(res.status()).toBe(400); // staff POST refuses up front, per the same pattern export uses
  });

  test("Tags page import panel renders correctly - UI smoke for the other mount point (TagsTable's own Share action + ImportTagSection/ImportTagPanel's composition)", async ({page}) => {
    const petId = await createPetApi(page, "TagsPageSmoke");
    const fixture = buildVerifiableProfile("TagsPageSmoke", "dog");
    await seedCustodiedPet(page, petId, "70008", fixture);

    await page.goto("/tags");
    const row = page.locator("tr", {hasText: "TagsPageSmoke"});
    // WP4.9V FIX ROUND 1 (D4): `/tags` is compiled on demand by `next dev`, and this is the FIRST
    // navigation to it anywhere in this file - when this spec runs in isolation (its own
    // verification requirement), nothing has warmed this route yet. Same cold-compile reasoning as
    // f6c7f3a's identical hardening of the export QR panel's own visibility check just above.
    await expect(row).toBeVisible({timeout: 15_000});

    await page.getByRole("button", {name: "Import tag"}).click();
    await page.getByRole("button", {name: "Create new pet from verified data"}).click();
    await expect(page.getByRole("button", {name: "Generate code"})).toBeEnabled();

    // TagsTable's own "Share tag data" row action, the sibling mount point on this same page -
    // scoped to THIS pet's row, since the shared test database may carry other tagged pets by now.
    await row.getByRole("button", {name: "Share tag data"}).click();
    await expect(page.getByText("Scan with the owner's DogTag app")).toBeVisible({timeout: 15_000}); // POST + client QR render can outrun the 5s default under load
  });
});

test.describe("verify a redacted artifact page (WP4.10V item 5, item 7 e2e coverage)", () => {
  test("happy path: a genuine masked artifact pastes as Verified, chain-anchored, its masked field distinct from its disclosed one", async ({page}) => {
    const dogTagIdDec = "70010";
    const fieldDec = dogTagIdField(dogTagIdDec).toString(10);
    const fixture = buildVerifiableProfile("Nova", "dog");
    const [nameLeaf, speciesLeaf] = fixture.leaves;
    const maskedHash = toHex32(hashLeaf(speciesLeaf!.keyPath, hexToBytes(speciesLeaf!.saltHex), {tag: speciesLeaf!.tag, value: speciesLeaf!.value} as TypedScalar));
    const artifact = {
      protocolVersion: "dogtag-v2/1",
      dogTagIdDec,
      dogTagIdField: fieldDec,
      root: fixture.root,
      disclosed: [nameLeaf!],
      obfuscatedLeafHashes: [maskedHash],
      reservedLeafHashes: fixture.reservedLeafHashes,
      issuerClone: FOREIGN_CLONE,
    };
    // Sanity: the fixture itself is genuine before it ever reaches the page - a failure here would
    // mean the TEST is broken, not the feature under test.
    expect(verifyRedactedArtifact(artifact)).toBe(true);

    await setRpcScenario("profileRoot", SBT_ADDRESS, [fieldDec], fixture.root);
    await setRpcScenario("rootIssuer", FACTORY_ADDRESS, [fixture.root], FOREIGN_CLONE);
    await setRpcScenario("isValid", FOREIGN_CLONE, [fixture.root], true);

    await page.goto("/verify/redacted");
    await page.getByPlaceholder("Paste a RedactedTagArtifact JSON document here...").fill(JSON.stringify(artifact));
    await page.getByRole("button", {name: "Verify"}).click();
    // POST + chain reads can outrun the 5s default under load.
    await expect(page.getByText("Verified", {exact: true})).toBeVisible({timeout: 15_000});
    // `exact: true` matters: the pasted JSON still sitting in the textarea above also contains the
    // literal substring "credentialSubject.name" (inside a much longer blob), but the textarea's
    // FULL normalized text is never exactly "credentialSubject.name" - only the rendered <li> in
    // the result panel is, so this excludes the textarea without a strict-mode violation.
    await expect(page.getByText("credentialSubject.name", {exact: true})).toBeVisible();
    await expect(page.getByText("credentialSubject.species")).not.toBeVisible(); // masked, never disclosed - absent even from the textarea's own JSON
    await expect(page.getByText("1 field masked")).toBeVisible();
  });

  test("negative: a tampered artifact (a disclosed value edited after the root was computed) fails cryptographic verification, never silently accepted", async ({page}) => {
    const dogTagIdDec = "70011";
    const fieldDec = dogTagIdField(dogTagIdDec).toString(10);
    const fixture = buildVerifiableProfile("Ash", "cat");
    const [nameLeaf, speciesLeaf] = fixture.leaves;
    const maskedHash = toHex32(hashLeaf(speciesLeaf!.keyPath, hexToBytes(speciesLeaf!.saltHex), {tag: speciesLeaf!.tag, value: speciesLeaf!.value} as TypedScalar));
    const tamperedArtifact = {
      protocolVersion: "dogtag-v2/1",
      dogTagIdDec,
      dogTagIdField: fieldDec,
      root: fixture.root,
      disclosed: [{...nameLeaf!, value: "NOT-REAL"}],
      obfuscatedLeafHashes: [maskedHash],
      reservedLeafHashes: fixture.reservedLeafHashes,
      issuerClone: FOREIGN_CLONE,
    };
    // Sanity: genuinely broken before it ever reaches the page (crypto_failed never even reaches the
    // chain - verifyRedactedFlow.test.ts's own unit test already pins that; no rpc scenario needed).
    expect(verifyRedactedArtifact(tamperedArtifact)).toBe(false);

    await page.goto("/verify/redacted");
    await page.getByPlaceholder("Paste a RedactedTagArtifact JSON document here...").fill(JSON.stringify(tamperedArtifact));
    await page.getByRole("button", {name: "Verify"}).click();
    await expect(page.getByText("Failed", {exact: true})).toBeVisible({timeout: 15_000});
  });
});
