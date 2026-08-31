import {expect, test, type Page} from "@playwright/test";
import {concat, keccak256, toBytes} from "viem";
import {privateKeyToAccount, generatePrivateKey} from "viem/accounts";
import {
  buildMerkle,
  dogTagIdField,
  hashLeaf,
  hexToBytes,
  toHex32,
  TypeTag,
  verifyLeafCommitment,
  type OpenedLeaf,
  type TypedScalar,
} from "@dogtag/standard";
import {setRpcScenario, resetRpcStub, forceRpcCallFailure} from "./rpcStub";

/**
 * End-to-end coverage for plans/wp4.4-mobile-booking-protocol.md's dogtag-vet flow: the token fix
 * (section 0), the signed wallet claim's accept/reject paths (section 2), and every tag-claim
 * reconciliation tier (section 3) - local (clean and ownership-mismatch), unknown (zero root and
 * chain-unreadable), issued_here_unlinked (plus its staff relink action), and external (appointment-
 * only, Q3-verified import, and import dedupe).
 *
 * The signing/hashing side below is a DELIBERATELY independent, hand-rolled copy of the
 * `MobileBooking` EIP-712 struct and the `bookingHash` hash-of-hashes formula - not imported from
 * `src/lib/booking/mobileEip712.ts`/`bookingHash.ts` - the same "keep a separate copy" philosophy
 * `wallet-registration.spec.ts` documents for `ClientRegistration`: importing the production
 * function here would let a bug in it "verify" against itself, since the test would sign over
 * whatever value the buggy function produced.
 *
 * Tag-claim tiers 2-4 are driven via `rpcStub.ts` (`global-setup.ts` starts it for the whole run;
 * `playwright.config.ts` points the web server's ROAX_RPC_URL at it) - real chain state for a
 * foreign-clone or a chain-unreadable scenario has no practical on-demand equivalent otherwise.
 */

const SHOTS_DIR = "/private/tmp/claude-501/-Users-zhenhaowu-code-dogtag/85e989bd-eec1-4250-ab09-83fb3244d856/scratchpad/wp44-shots";

// Matches playwright.config.ts's webServer env exactly - the addresses the RUNNING APP is
// configured with, which is what it actually calls out to the RPC stub with.
const SBT_ADDRESS = "0x276101555b2cd92be0fb85ff908e02281d6a3cf9";
const FACTORY_ADDRESS = "0x1bd279d3c9fc85eb3e4d304ee890435b6a5ca4cc";
const OUR_CLONE = "0x7b9bf16f0e39adf8c38d8491f4c7e9c17e85d703"; // configureClinic's own cloneAddress
const FOREIGN_CLONE = `0x${"ee".repeat(20)}`;

const PRIMARY_TYPE = "MobileBooking" as const;
const TYPES = {
  MobileBooking: [
    {name: "clinic", type: "address"},
    {name: "bookingHash", type: "bytes32"},
    {name: "wallet", type: "address"},
    {name: "issuedAt", type: "uint64"},
    {name: "deadline", type: "uint64"},
  ],
} as const;

/** Independent hash-of-hashes recomputation of `bookingHash` - see this file's own doc comment on
 * why this is not imported from `lib/booking/bookingHash.ts`. */
function computeBookingHash(input: {serviceId: string; startAt: number; clientName: string; clientEmail: string; clientPhone?: string; dogTagIdField?: string}) {
  const hashField = (v: string) => keccak256(toBytes(v));
  return keccak256(
    concat([
      hashField(input.serviceId),
      hashField(String(input.startAt)),
      hashField(input.clientName.trim()),
      hashField(input.clientEmail.trim().toLowerCase()),
      hashField(input.clientPhone?.trim() ?? ""),
      hashField(input.dogTagIdField?.trim() ?? ""),
    ]),
  );
}

async function signWalletClaim(params: {
  chainId: number;
  clinic: `0x${string}`;
  bookingHash: `0x${string}`;
  issuedAt: number;
  deadline: number;
  signer: ReturnType<typeof privateKeyToAccount>;
  claimedWallet?: `0x${string}`;
}) {
  const domain = {name: "DogTagMobileBooking" as const, version: "1" as const, chainId: params.chainId, verifyingContract: params.clinic};
  const message = {
    clinic: params.clinic,
    bookingHash: params.bookingHash,
    wallet: params.claimedWallet ?? params.signer.address,
    issuedAt: BigInt(params.issuedAt),
    deadline: BigInt(params.deadline),
  };
  const signature = await params.signer.signTypedData({domain, types: TYPES, primaryType: PRIMARY_TYPE, message});
  return {address: params.claimedWallet ?? params.signer.address, signature};
}

async function signInAsStaff(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", {name: "Dev sign in (test only)"}).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** Idempotent, mirrors `wallet-registration.spec.ts`'s own `configureClinic`. */
async function configureClinic(page: Page) {
  const res = await page.request.patch("/api/settings", {
    data: {cloneAddress: OUR_CLONE, businessProfile: {name: "Example Vet Clinic"}},
  });
  expect(res.ok()).toBe(true);
}

interface Service {
  id: string;
  name: string;
}

async function getCheckupService(page: Page): Promise<Service> {
  const res = await page.request.get("/v1/booking/services");
  const list = await res.json();
  const service = list.find((s: Service) => s.name === "General checkup");
  expect(service).toBeTruthy();
  return service;
}

/** A future, presumably-open slot, `offsetDays` out - spread across tests so none share a slot. */
async function openSlot(page: Page, service: Service, offsetDays: number): Promise<number> {
  const from = new Date(Date.now() + offsetDays * 86_400_000);
  const to = new Date(from.getTime() + 3 * 86_400_000);
  const res = await page.request.get(`/v1/booking/availability?serviceId=${service.id}&from=${from.toISOString()}&to=${to.toISOString()}`);
  const body = await res.json();
  expect(body.slots.length).toBeGreaterThan(0);
  return Math.floor(new Date(body.slots[0].startAt).getTime() / 1000);
}

interface BookResult {
  status: number;
  body: {appointmentId?: string; status?: string; token?: string; ics?: string; error?: {code: string; message: string; details?: Record<string, unknown>}};
}

/** `POST /v1/booking/book` is rate-limited (10/min per client key - `enforceRateLimit` in the
 * route itself), and this whole suite makes far more than 10 calls to it. Every call gets its OWN
 * `cf-connecting-ip` (a monotonic counter, mirroring `wallet-registration.spec.ts`'s own per-call
 * IP convention) so no two book() calls anywhere in this file - even across different tests - ever
 * share a rate-limit bucket. */
let nextBookingIp = 1;
async function book(page: Page, data: Record<string, unknown>): Promise<BookResult> {
  const n = nextBookingIp++;
  const ip = `10.4.${Math.floor(n / 250)}.${(n % 250) + 1}`;
  const res = await page.request.post("/v1/booking/book", {data, headers: {"cf-connecting-ip": ip}});
  return {status: res.status(), body: await res.json()};
}

async function getAppointmentDirect(page: Page, appointmentId: string) {
  const res = await page.request.get(`/api/appointments/${appointmentId}`);
  expect(res.ok()).toBe(true);
  return res.json();
}

async function createPetApi(page: Page, name: string, ownerClientIds: string[]): Promise<string> {
  const res = await page.request.post("/api/pets", {data: {name, ownerClientIds}});
  expect(res.ok()).toBe(true);
  return (await res.json()).petId as string;
}

async function createClientApi(page: Page, name: string, email: string): Promise<string> {
  const res = await page.request.post("/api/clients", {data: {name, email}});
  expect(res.ok()).toBe(true);
  return (await res.json()).clientId as string;
}

/** Sets `Pet.dogTag.dogTagIdDec`/`dogTagIdField` directly via a staff PATCH-equivalent - there is
 * no staff API for this specific field today (tags are normally sealed by the mint flow), so this
 * goes through the one write surface that exists for it: the mint reconcile's own `linkPetDogTag`
 * write path, reachable here via the relink endpoint IF the tier already resolved
 * issued_here_unlinked - which is circular for seeding a LOCAL match fixture. Instead, seed
 * directly against Mongo, mirroring how `wallet-registration.spec.ts` reaches into Mongo directly
 * for state no API exposes. */
async function seedLocalDogTag(page: Page, petId: string, dogTagIdDec: string) {
  const {MongoClient} = await import("mongodb");
  const {E2E_MONGO_URI} = await import("./mongo-fixture");
  const client = new MongoClient(E2E_MONGO_URI);
  await client.connect();
  try {
    await client.db().collection("pets").updateOne(
      {petId},
      {$set: {"dogTag.dogTagIdDec": dogTagIdDec, "dogTag.dogTagIdField": dogTagIdField(dogTagIdDec).toString(10), "dogTag.status": "active"}},
    );
  } finally {
    await client.close();
  }
  void page;
}

async function setTheme(page: Page, theme: "Light" | "Dark") {
  await page.getByRole("radio", {name: theme}).click();
  await expect(page.getByRole("radio", {name: theme})).toHaveAttribute("aria-checked", "true");
  if (theme === "Dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
  // The toggle's own selected-pill background is `transition-colors` (a CSS transition, not an
  // instant style swap) - two rAFs proves a frame has been COMPOSITED (right for confirming the
  // page's colors themselves, an instant class toggle), but is nowhere near a typical ~150ms
  // transition's full duration. Caught live: screenshotting right after the 2-rAF wait alone
  // showed the PREVIOUS button's pill still visibly mid-fade-out while the new one was still
  // fading in, at the same time the page's own background had already fully switched (confirmed
  // by the passing aria-checked/html-class assertions above, which are instant, not transitioned) -
  // a real screenshot capturing a real mid-transition frame, not a test bug in the assertions.
  await page.waitForTimeout(300);
}

/** Builds a genuine (leaves, reservedLeafHashes, root) triple the real `verifyLeafCommitment`
 * accepts - mirrors `dogtag-standard-ts/test/profile_bind.test.ts`'s own pattern (hashLeaf +
 * buildMerkle, the exact primitives verifyLeafCommitment itself recomputes with), never a
 * hand-rolled parallel encoding. */
function buildVerifiablePetProfile(species: string, breedLabel: string) {
  const salt = (n: number) => new Uint8Array(16).fill(n);
  const saltHexOf = (n: number) => ("0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
  const leaves: OpenedLeaf[] = [
    {keyPath: "credentialSubject.species", saltHex: saltHexOf(11), tag: TypeTag.String, value: species},
    {keyPath: "credentialSubject.breedLabel", saltHex: saltHexOf(12), tag: TypeTag.String, value: breedLabel},
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

test.beforeEach(async ({page}) => {
  await signInAsStaff(page);
  await configureClinic(page);
  await resetRpcStub();
});

test.describe("section 0: the token fix", () => {
  test("book -> the response carries token -> status via token -> cancel via token", async ({page}) => {
    const service = await getCheckupService(page);
    const startAt = await openSlot(page, service, 5);

    const result = await book(page, {
      serviceId: service.id,
      startAt: new Date(startAt * 1000).toISOString(),
      client: {name: "Token Fix Case", email: "token-fix@example.com"},
      petName: "Fixie",
    });
    expect(result.status).toBe(201);
    expect(result.body.token).toBeTruthy();
    expect(result.body.token).not.toBe(result.body.appointmentId); // was the historical fallback that always 401'd

    const appointmentId = result.body.appointmentId!;
    const token = result.body.token!;

    const statusRes = await page.request.get(`/v1/booking/appointments/${appointmentId}?token=${token}`);
    expect(statusRes.ok()).toBe(true);
    expect((await statusRes.json()).status).toBe("confirmed");

    const cancelRes = await page.request.post(`/v1/booking/appointments/${appointmentId}/cancel?token=${token}`);
    expect(cancelRes.ok()).toBe(true);
    expect((await cancelRes.json()).status).toBe("cancelled");
  });
});

test.describe("section 2: the signed wallet claim", () => {
  test("a bad signature (wrong signer) rejects the whole booking - nothing is created", async ({page}) => {
    const service = await getCheckupService(page);
    const startAt = await openSlot(page, service, 6);
    const client = {name: "Bad Sig Case", email: "bad-sig@example.com"};
    const now = Math.floor(Date.now() / 1000);
    const bookingHash = computeBookingHash({serviceId: service.id, startAt, clientName: client.name, clientEmail: client.email});

    const signer = privateKeyToAccount(generatePrivateKey());
    const claimedWallet = privateKeyToAccount(generatePrivateKey()).address; // NOT the signer
    const {address, signature} = await signWalletClaim({chainId: 135, clinic: OUR_CLONE, bookingHash, issuedAt: now, deadline: now + 300, signer, claimedWallet});

    const result = await book(page, {
      serviceId: service.id,
      startAt: new Date(startAt * 1000).toISOString(),
      client,
      mobile: {source: "dogtag_app", wallet: {address, signature, issuedAt: now, deadline: now + 300}},
    });
    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe("wallet_claim_invalid");
    expect(result.body.error?.details?.reason).toBe("signature_invalid");

    // Confirm nothing was created: no client with this email exists.
    const clientsRes = await page.request.get(`/api/clients?q=${encodeURIComponent(client.email)}`);
    expect(await clientsRes.json()).toEqual([]);
  });

  test("an expired deadline rejects the whole booking", async ({page}) => {
    const service = await getCheckupService(page);
    const startAt = await openSlot(page, service, 7);
    const client = {name: "Expired Case", email: "expired-case@example.com"};
    const now = Math.floor(Date.now() / 1000);
    const bookingHash = computeBookingHash({serviceId: service.id, startAt, clientName: client.name, clientEmail: client.email});

    const signer = privateKeyToAccount(generatePrivateKey());
    const issuedAt = now - 700;
    const deadline = issuedAt + 600; // 100s before now
    const {address, signature} = await signWalletClaim({chainId: 135, clinic: OUR_CLONE, bookingHash, issuedAt, deadline, signer});

    const result = await book(page, {
      serviceId: service.id,
      startAt: new Date(startAt * 1000).toISOString(),
      client,
      mobile: {source: "dogtag_app", wallet: {address, signature, issuedAt, deadline}},
    });
    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe("wallet_claim_invalid");
    expect(result.body.error?.details?.reason).toBe("expired");
  });

  test("replaying the exact same signed claim a second time is rejected, and the first booking is untouched", async ({page}) => {
    const service = await getCheckupService(page);
    const startAt = await openSlot(page, service, 8);
    const client = {name: "Replay Case", email: "replay-case@example.com"};
    const now = Math.floor(Date.now() / 1000);
    const bookingHash = computeBookingHash({serviceId: service.id, startAt, clientName: client.name, clientEmail: client.email});
    const signer = privateKeyToAccount(generatePrivateKey());
    const {address, signature} = await signWalletClaim({chainId: 135, clinic: OUR_CLONE, bookingHash, issuedAt: now, deadline: now + 300, signer});

    const mobile = {source: "dogtag_app", wallet: {address, signature, issuedAt: now, deadline: now + 300}};
    const requestBody = {serviceId: service.id, startAt: new Date(startAt * 1000).toISOString(), client, mobile};

    const first = await book(page, requestBody);
    expect(first.status).toBe(201);

    const second = await book(page, requestBody);
    expect(second.status).toBe(400);
    expect(second.body.error?.code).toBe("wallet_claim_replayed");

    const firstAppointment = await getAppointmentDirect(page, first.body.appointmentId!);
    expect(firstAppointment.status).toBe("scheduled");
  });

  test("wallet-match-first: a second booking from the SAME wallet (different content, different claimed client fields) resolves to the SAME client, and the wallet is attached exactly once, via:booking", async ({page}) => {
    const service = await getCheckupService(page);
    const signer = privateKeyToAccount(generatePrivateKey());

    const startAt1 = await openSlot(page, service, 9);
    const client1 = {name: "Wallet Owner", email: "wallet-owner@example.com"};
    const now1 = Math.floor(Date.now() / 1000);
    const hash1 = computeBookingHash({serviceId: service.id, startAt: startAt1, clientName: client1.name, clientEmail: client1.email});
    const sig1 = await signWalletClaim({chainId: 135, clinic: OUR_CLONE, bookingHash: hash1, issuedAt: now1, deadline: now1 + 300, signer});
    const first = await book(page, {
      serviceId: service.id,
      startAt: new Date(startAt1 * 1000).toISOString(),
      client: client1,
      mobile: {source: "dogtag_app", wallet: {address: sig1.address, signature: sig1.signature, issuedAt: now1, deadline: now1 + 300}},
    });
    expect(first.status).toBe(201);
    const firstAppointment = await getAppointmentDirect(page, first.body.appointmentId!);
    const clientId = firstAppointment.clientId as string;
    expect(clientId).toBeTruthy();

    // Second booking: same wallet, DIFFERENT claimed name/email (a plausible "app pre-fill was
    // stale" case) - Q1 says the WALLET wins over the claimed contact fields.
    const startAt2 = await openSlot(page, service, 10);
    const client2 = {name: "Wallet Owner Renamed", email: "different-email@example.com"};
    const now2 = Math.floor(Date.now() / 1000);
    const hash2 = computeBookingHash({serviceId: service.id, startAt: startAt2, clientName: client2.name, clientEmail: client2.email});
    const sig2 = await signWalletClaim({chainId: 135, clinic: OUR_CLONE, bookingHash: hash2, issuedAt: now2, deadline: now2 + 300, signer});
    const second = await book(page, {
      serviceId: service.id,
      startAt: new Date(startAt2 * 1000).toISOString(),
      client: client2,
      mobile: {source: "dogtag_app", wallet: {address: sig2.address, signature: sig2.signature, issuedAt: now2, deadline: now2 + 300}},
    });
    expect(second.status).toBe(201);
    const secondAppointment = await getAppointmentDirect(page, second.body.appointmentId!);
    expect(secondAppointment.clientId).toBe(clientId); // wallet-match-first, not a new client from the claimed email

    const clientRes = await page.request.get(`/api/clients/${clientId}`);
    const clientDoc = await clientRes.json();
    const matchingWallets = clientDoc.wallets.filter((w: {address: string}) => w.address === signer.address.toLowerCase());
    expect(matchingWallets.length).toBe(1); // attached once, not re-attached on the second booking
    expect(matchingWallets[0].via).toBe("booking");
    expect(matchingWallets[0].bookingId).toBe(first.body.appointmentId);
  });
});

test.describe("section 3: tag-claim tiers", () => {
  test("tier 1 (local, clean match): links the pet directly, no chain read needed", async ({page}) => {
    const clientId = await createClientApi(page, "Local Match Owner", "local-match-owner@example.com");
    const petId = await createPetApi(page, "Locally Known Pet", [clientId]);
    await seedLocalDogTag(page, petId, "555001");

    const service = await getCheckupService(page);
    const startAt = await openSlot(page, service, 11);
    const result = await book(page, {
      serviceId: service.id,
      startAt: new Date(startAt * 1000).toISOString(),
      client: {name: "Local Match Owner", email: "local-match-owner@example.com"},
      mobile: {source: "dogtag_app", pet: {dogTagIdDec: "555001"}},
    });
    expect(result.status).toBe(201);
    const appointment = await getAppointmentDirect(page, result.body.appointmentId!);
    expect(appointment.petIds).toEqual([petId]);
    expect(appointment.bookingIdentity.tagResolution).toBe("local");
    expect(appointment.bookingIdentity.needsReview).toBeFalsy();
  });

  test("tier 1 (local, ownership mismatch): does NOT link the pet, flags needsReview with candidatePetId", async ({page}) => {
    const ownerClientId = await createClientApi(page, "Real Owner", "real-owner@example.com");
    const petId = await createPetApi(page, "Someone Elses Pet", [ownerClientId]);
    await seedLocalDogTag(page, petId, "555002");

    const service = await getCheckupService(page);
    const startAt = await openSlot(page, service, 12);
    const result = await book(page, {
      serviceId: service.id,
      startAt: new Date(startAt * 1000).toISOString(),
      client: {name: "Unrelated Booker", email: "unrelated-booker@example.com"},
      mobile: {source: "dogtag_app", pet: {dogTagIdDec: "555002"}},
    });
    expect(result.status).toBe(201);
    const appointment = await getAppointmentDirect(page, result.body.appointmentId!);
    expect(appointment.petIds).toEqual([]); // withheld, not silently linked
    expect(appointment.bookingIdentity.tagResolution).toBe("local");
    expect(appointment.bookingIdentity.needsReview).toBe(true);
    expect(appointment.bookingIdentity.candidatePetId).toBe(petId);
  });

  test("tier 2 (unknown, zero root): booking is kept, claim is set aside", async ({page}) => {
    const service = await getCheckupService(page);
    const startAt = await openSlot(page, service, 13);
    const result = await book(page, {
      serviceId: service.id,
      startAt: new Date(startAt * 1000).toISOString(),
      client: {name: "Unknown Tag Case", email: "unknown-tag@example.com"},
      mobile: {source: "dogtag_app", pet: {dogTagIdDec: "999999"}}, // never scripted, never seeded - the stub's default zero root
    });
    expect(result.status).toBe(201);
    const appointment = await getAppointmentDirect(page, result.body.appointmentId!);
    expect(appointment.petIds).toEqual([]);
    expect(appointment.bookingIdentity.tagResolution).toBe("unknown");
    expect(appointment.bookingIdentity.verificationError).toBeFalsy();
  });

  test("chain-read failure never loses the booking: unknown with verificationError, but the appointment is still created", async ({page}) => {
    await forceRpcCallFailure();
    const service = await getCheckupService(page);
    const startAt = await openSlot(page, service, 14);
    const result = await book(page, {
      serviceId: service.id,
      startAt: new Date(startAt * 1000).toISOString(),
      client: {name: "Chain Down Case", email: "chain-down@example.com"},
      mobile: {source: "dogtag_app", pet: {dogTagIdDec: "777777"}},
    });
    expect(result.status).toBe(201); // NOT a 500 or a lost booking
    const appointment = await getAppointmentDirect(page, result.body.appointmentId!);
    expect(appointment.bookingIdentity.tagResolution).toBe("unknown");
    expect(appointment.bookingIdentity.verificationError).toBe(true);
  });

  test("tier 3 (issued_here_unlinked): flags for staff, and the relink action seals it onto the chosen pet", async ({page}) => {
    const dogTagIdDec = "555003";
    const fieldDec = dogTagIdField(dogTagIdDec).toString(10);
    const root = `0x${"ab".repeat(32)}`;
    await setRpcScenario("profileRoot", SBT_ADDRESS, [fieldDec], root);
    await setRpcScenario("rootIssuer", FACTORY_ADDRESS, [root], OUR_CLONE);

    const clientId = await createClientApi(page, "Restore Case Owner", "restore-case@example.com");
    const service = await getCheckupService(page);
    const startAt = await openSlot(page, service, 15);
    const result = await book(page, {
      serviceId: service.id,
      startAt: new Date(startAt * 1000).toISOString(),
      client: {name: "Restore Case Owner", email: "restore-case@example.com"},
      mobile: {source: "dogtag_app", pet: {dogTagIdDec}},
    });
    expect(result.status).toBe(201);
    const appointmentId = result.body.appointmentId!;
    let appointment = await getAppointmentDirect(page, appointmentId);
    expect(appointment.petIds).toEqual([]);
    expect(appointment.bookingIdentity.tagResolution).toBe("issued_here_unlinked");
    expect(appointment.bookingIdentity.issuerClone).toBe(OUR_CLONE);

    // Staff relinks it to a pet they create for this purpose.
    const petId = await createPetApi(page, "Recovered Pet", [clientId]);
    const relinkRes = await page.request.post(`/api/appointments/${appointmentId}/relink-dogtag`, {data: {petId}});
    expect(relinkRes.ok()).toBe(true);

    appointment = await getAppointmentDirect(page, appointmentId);
    expect(appointment.petIds).toEqual([petId]);

    const petRes = await page.request.get(`/api/pets/${petId}`);
    const pet = await petRes.json();
    expect(pet.dogTag.dogTagIdDec).toBe(dogTagIdDec);
    expect(pet.dogTag.root).toBe(root);
    expect(pet.dogTag.cloneAddress).toBe(OUR_CLONE);
  });

  test("tier 4 (external, appointment-only): no verification data sent - issuer identified, no pet imported", async ({page}) => {
    const dogTagIdDec = "555004";
    const fieldDec = dogTagIdField(dogTagIdDec).toString(10);
    const root = `0x${"cd".repeat(32)}`;
    await setRpcScenario("profileRoot", SBT_ADDRESS, [fieldDec], root);
    await setRpcScenario("rootIssuer", FACTORY_ADDRESS, [root], FOREIGN_CLONE);
    await setRpcScenario("isValid", FOREIGN_CLONE, [root], true);

    const service = await getCheckupService(page);
    const startAt = await openSlot(page, service, 16);
    const result = await book(page, {
      serviceId: service.id,
      startAt: new Date(startAt * 1000).toISOString(),
      client: {name: "External No Data Case", email: "external-no-data@example.com"},
      mobile: {source: "dogtag_app", pet: {dogTagIdDec}},
    });
    expect(result.status).toBe(201);
    const appointment = await getAppointmentDirect(page, result.body.appointmentId!);
    expect(appointment.petIds).toEqual([]);
    expect(appointment.bookingIdentity.tagResolution).toBe("external");
    expect(appointment.bookingIdentity.issuerClone).toBe(FOREIGN_CLONE);
    expect(appointment.bookingIdentity.issuerValid).toBe(true);
    expect(appointment.bookingIdentity.dataVerificationAttempted).toBeFalsy();
    expect(appointment.bookingIdentity.dataVerified).toBeFalsy();
  });

  test("tier 4 (external, Q3 verified import): imports a provisional pet, then dedupes a second booking onto the SAME pet", async ({page}) => {
    const dogTagIdDec = "555005";
    const fieldDec = dogTagIdField(dogTagIdDec).toString(10);
    const {leaves, reservedLeafHashes, root} = buildVerifiablePetProfile("dog", "Beagle");
    await setRpcScenario("profileRoot", SBT_ADDRESS, [fieldDec], root);
    await setRpcScenario("rootIssuer", FACTORY_ADDRESS, [root], FOREIGN_CLONE);
    await setRpcScenario("isValid", FOREIGN_CLONE, [root], true);

    const service = await getCheckupService(page);
    const startAt1 = await openSlot(page, service, 17);
    const first = await book(page, {
      serviceId: service.id,
      startAt: new Date(startAt1 * 1000).toISOString(),
      client: {name: "External Verified Owner", email: "external-verified@example.com"},
      mobile: {source: "dogtag_app", pet: {dogTagIdDec, name: "Buddy", leaves, reservedLeafHashes}},
    });
    expect(first.status).toBe(201);
    const firstAppointment = await getAppointmentDirect(page, first.body.appointmentId!);
    expect(firstAppointment.bookingIdentity.tagResolution).toBe("external");
    expect(firstAppointment.bookingIdentity.dataVerified).toBe(true);
    expect(firstAppointment.petIds.length).toBe(1);
    const importedPetId = firstAppointment.petIds[0] as string;

    const petRes = await page.request.get(`/api/pets/${importedPetId}`);
    const importedPet = await petRes.json();
    expect(importedPet.species).toBe("dog");
    expect(importedPet.breed).toBe("Beagle");
    expect(importedPet.dogTag.external).toBe(true);
    expect(importedPet.dogTag.cloneAddress).toBe(FOREIGN_CLONE);

    // A second booking with the SAME tag, same client, reuses the SAME pet - no duplicate import.
    const startAt2 = await openSlot(page, service, 18);
    const second = await book(page, {
      serviceId: service.id,
      startAt: new Date(startAt2 * 1000).toISOString(),
      client: {name: "External Verified Owner", email: "external-verified@example.com"},
      mobile: {source: "dogtag_app", pet: {dogTagIdDec, name: "Buddy", leaves, reservedLeafHashes}},
    });
    expect(second.status).toBe(201);
    const secondAppointment = await getAppointmentDirect(page, second.body.appointmentId!);
    expect(secondAppointment.petIds).toEqual([importedPetId]);

    // Excluded from this clinic's own tags surface.
    const tagsRes = await page.request.get("/api/tags");
    const tagsBody = await tagsRes.json();
    expect(tagsBody.issued.some((p: {petId: string}) => p.petId === importedPetId)).toBe(false);
  });
});

test("screenshots (both themes): provenance box (external, verified import) and the appointments list source filter", async ({page}) => {
  const dogTagIdDec = "555009";
  const fieldDec = dogTagIdField(dogTagIdDec).toString(10);
  const {leaves, reservedLeafHashes, root} = buildVerifiablePetProfile("dog", "Golden Retriever");
  await setRpcScenario("profileRoot", SBT_ADDRESS, [fieldDec], root);
  await setRpcScenario("rootIssuer", FACTORY_ADDRESS, [root], FOREIGN_CLONE);
  await setRpcScenario("isValid", FOREIGN_CLONE, [root], true);

  const service = await getCheckupService(page);
  const startAt = await openSlot(page, service, 40);
  const result = await book(page, {
    serviceId: service.id,
    startAt: new Date(startAt * 1000).toISOString(),
    client: {name: "Shot Case Owner", email: "shot-case-owner@example.com"},
    mobile: {source: "dogtag_app", pet: {dogTagIdDec, name: "Shotty", leaves, reservedLeafHashes}},
  });
  expect(result.status).toBe(201);
  const appointmentId = result.body.appointmentId!;

  for (const theme of ["Light", "Dark"] as const) {
    await page.goto(`/appointments/${appointmentId}`);
    await setTheme(page, theme);
    // NOT a `page.screenshot({fullPage: true})`: the app shell (`(app)/layout.tsx`) is a
    // fixed-height flex column with `<main class="overflow-y-auto">` as the ONLY scrollable
    // element - the outer document never grows past one viewport, so a fullPage screenshot
    // silently captures just the first ~720px and misses anything scrolled below it (confirmed
    // live: without this fix, the captured image ended at the Notes section, well above the
    // Provenance box entirely). A locator screenshot scrolls its OWN element into view first and
    // captures its real rendered bounds regardless of an ancestor's scroll position.
    const provenanceBox = page.getByTestId("provenance-box");
    await expect(provenanceBox).toBeVisible();
    await provenanceBox.screenshot({path: `${SHOTS_DIR}/provenance-box-${theme.toLowerCase()}.png`});
  }

  // Filter FIRST, set the theme LAST, once per iteration - `selectOption` triggers a
  // `router.replace` (a same-page RSC refresh for the new `?source=` query param), and doing that
  // AFTER `setTheme` left a brief window where the refresh's own re-render could land between
  // `setTheme`'s assertions and the screenshot; putting the theme change last removes that window
  // entirely rather than papering over it with an extra wait.
  await page.goto("/appointments");
  await page.getByLabel("Filter by source").selectOption("mobile");
  await expect(page.getByRole("cell", {name: "Mobile app"}).first()).toBeVisible();
  for (const theme of ["Light", "Dark"] as const) {
    await setTheme(page, theme);
    // Viewport screenshot, not fullPage - the filter bar and the filtered rows are both above the
    // fold already, and (per the note above) fullPage would not capture anything past one viewport
    // height on this layout regardless.
    await page.screenshot({path: `${SHOTS_DIR}/appointments-source-filter-${theme.toLowerCase()}.png`});
  }
});
