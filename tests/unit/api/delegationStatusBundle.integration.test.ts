import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {buildMerkle, hashLeaf, hexToBytes, toHex32, TypeTag, verifyLeafCommitment, type OpenedLeaf, type TypedScalar} from "@dogtag/standard";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.15V grade round 1, D3 (MAJOR) - "The co-owner bundle is never asserted on the wire, at any
 * level." Before this file, `tests/unit/delegation/bundle.test.ts` only ever exercised the pure
 * `buildDelegationCoOwnerBundle` function directly, and no test at any level called
 * `GET /d/:token/status` against a REAL confirmed session and looked at its response body - so
 * `status/route.ts`'s own `tryBuildBundle` (the code that actually finds the artifact, reads
 * `delegationLeaves` live, and attaches `bundle` to the response) had zero coverage. This file
 * closes that gap at the route level, and also proves the other D3 fix: a bundle that could not be
 * built no longer looks IDENTICAL on the wire to "not ready yet" - it now carries
 * `bundleUnavailable: true`.
 *
 * `readDelegationLeaves` is the one dependency this route cannot exercise for real in a vitest
 * environment (no chain) - mocked here via `vi.mock("@/lib/chainRead", ...)`, keeping every other
 * export of that module real via `importActual` (nothing else in this route's call graph needs a
 * live chain read - `getDelegationSessionStatusForDevice` is pure Mongo, confirmed by reading it).
 *
 * ISOLATION: own ephemeral mongod, port 44139 (44138 is
 * tests/unit/api/primaryOwnerClientIdIssuanceStart.integration.test.ts's own port, this wave's
 * previous fix round - see that file's doc comment for the fuller port ledger).
 */
vi.mock("@/lib/chainRead", async () => {
  const actual = await vi.importActual<typeof import("@/lib/chainRead")>("@/lib/chainRead");
  return {...actual, readDelegationLeaves: vi.fn()};
});

import {readDelegationLeaves} from "@/lib/chainRead";
import {connectToDatabase} from "@/lib/db";
import {DelegationSession} from "@/lib/models/DelegationSession";
import {Pet} from "@/lib/models/Pet";
import {createTagArtifact, type CreateTagArtifactInput} from "@/lib/tags/artifact";
import {TagArtifact} from "@/lib/models/TagArtifact";
import {GET as publicStatusGET} from "@/app/d/[token]/status/route";

const MONGO_PORT = 44_139;
let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-delegation-status-bundle");
  process.env.MONGODB_URI = ephemeral.uri;
  process.env.DELEGATION_REGISTRY_ADDRESS = `0x${"5".repeat(40)}`;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  await TagArtifact.init(); // the unique `root` index builds in the background - wait for it.
}, 90_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
  delete process.env.DELEGATION_REGISTRY_ADDRESS;
});

afterEach(async () => {
  await Promise.all([DelegationSession.deleteMany({}), Pet.deleteMany({}), TagArtifact.deleteMany({})]);
  vi.mocked(readDelegationLeaves).mockReset();
});

const ISSUER_CLONE = "0x7b9bf16f0e39adf8c38d8491f4c7e9c17e85d703";
const CLINIC_NAME = "Example Vet Clinic";

/** Genuine (leaves, reservedLeafHashes, root) triple - `hashLeaf` + `buildMerkle`, the same
 * primitives `verifyLeafCommitment` (and, downstream, `buildRedactedExportPayload`'s own self-
 * check) recomputes with. Mirrors `tests/unit/models/tagArtifact.integration.test.ts`'s own
 * `buildVerifiableFixture` - a bundle recomputes its root via `verifyRedactedArtifact` and fails
 * closed on anything less than genuine crypto. */
function buildVerifiableFixture(): {leaves: OpenedLeaf[]; reservedLeafHashes: string[]; root: string} {
  const salt = (n: number) => new Uint8Array(16).fill(n);
  const saltHexOf = (n: number) => ("0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
  const leaves: OpenedLeaf[] = [
    {keyPath: "credentialSubject.species", saltHex: saltHexOf(11), tag: TypeTag.String, value: "dog"},
    {keyPath: "credentialSubject.name", saltHex: saltHexOf(12), tag: TypeTag.String, value: "Blaze"},
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

async function seedConfirmedAddSession(petId: string, dogTagIdField: string, commitment: string): Promise<string> {
  const token = randomUUID().replace(/-/g, "").slice(0, 32);
  const now = Math.floor(Date.now() / 1000);
  await DelegationSession.create({
    token,
    registrationId: randomUUID(),
    kind: "add",
    petId,
    dogTagIdField,
    clientId: randomUUID(),
    clinic: ISSUER_CLONE,
    chainId: 135,
    clinicName: CLINIC_NAME,
    maskedTargetName: "J***** R******",
    commitment: commitment.toLowerCase(),
    wallet: `0x${"1".repeat(40)}`,
    issuedAt: now - 60,
    blockNumber: 1,
    deadline: now + 600,
    status: "confirmed",
    consumed: true,
    consumedAt: now - 30,
  });
  return token;
}

function sixteenSlots(activeCommitment: `0x${string}`): `0x${string}`[] {
  const zero = `0x${"0".repeat(64)}` as const;
  const slots: `0x${string}`[] = Array.from({length: 16}, () => zero);
  slots[0] = activeCommitment;
  return slots;
}

describe("GET /d/:token/status - the co-owner bundle on the wire (grade round 1 D3)", () => {
  it("a confirmed session with a real TagArtifact returns status=added and a complete, well-formed bundle", async () => {
    const petId = randomUUID();
    const dogTagIdField = "424242";
    const commitment = `0x${"ab".repeat(32)}` as `0x${string}`;
    await Pet.create({petId, name: "Blaze", ownerClientIds: [], searchKey: "blaze"});
    const fixture = buildVerifiableFixture();
    const created = await createTagArtifact({
      petId,
      dogTagIdDec: dogTagIdField,
      dogTagIdField,
      root: fixture.root,
      protocolVersion: "dogtag-v2/1",
      schemaId: "https://dogtag.io/schemas/dog-profile/v1",
      leaves: fixture.leaves,
      reservedLeafHashes: fixture.reservedLeafHashes,
      expectedIdentityLeaves: [],
      source: "issued_here",
      issuerClone: ISSUER_CLONE,
      now: Math.floor(Date.now() / 1000),
    } satisfies CreateTagArtifactInput);
    expect(created.ok).toBe(true);
    vi.mocked(readDelegationLeaves).mockResolvedValue(sixteenSlots(commitment));

    const token = await seedConfirmedAddSession(petId, dogTagIdField, commitment);
    const res = await publicStatusGET(new Request(`https://vet.example.com/d/${token}/status`), {params: Promise.resolve({token})});
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe("added");
    expect(body.bundleUnavailable).toBeUndefined();
    const bundle = body.bundle as Record<string, unknown>;
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
    expect(bundle.protocolVersion).toBe("dogtag-v2/1");
    expect(bundle.dogTagIdField).toBe(dogTagIdField);
    expect((bundle.root as string).toLowerCase()).toBe(fixture.root.toLowerCase());
    expect(bundle.obfuscatedLeafHashes).toEqual([]); // this fixture discloses everything - nothing masked
    expect(bundle.reservedLeafHashes).toHaveLength(3);
    expect(bundle.delegationLeaves).toHaveLength(16);
    expect((bundle.delegationLeaves as string[])[0]).toBe(commitment);
    expect(bundle.issuerClone).toBe(ISSUER_CLONE);
    expect(bundle.chainId).toBe(135);
    expect(bundle.petName).toBe("Blaze");
    expect(bundle.clinicName).toBe(CLINIC_NAME);
  });

  it("a confirmed session with NO TagArtifact for the pet returns bundleUnavailable=true and no bundle key, instead of silently omitting both (D3's own bite)", async () => {
    const petId = randomUUID();
    const dogTagIdField = "555555";
    const commitment = `0x${"cd".repeat(32)}` as `0x${string}`;
    await Pet.create({petId, name: "Legacy Pet", ownerClientIds: [], searchKey: "legacy pet"});
    // Deliberately NO TagArtifact seeded - this pet predates WP4.9 custody records.
    vi.mocked(readDelegationLeaves).mockResolvedValue(sixteenSlots(commitment));

    const token = await seedConfirmedAddSession(petId, dogTagIdField, commitment);
    const res = await publicStatusGET(new Request(`https://vet.example.com/d/${token}/status`), {params: Promise.resolve({token})});
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe("added");
    expect(body.bundle).toBeUndefined();
    expect(body.bundleUnavailable).toBe(true);
  });

  it("a confirmed session where the live delegationLeaves read throws returns bundleUnavailable=true, and the outer status is still added (the bundle is additive, never turns a real success into an error)", async () => {
    const petId = randomUUID();
    const dogTagIdField = "666666";
    const commitment = `0x${"ef".repeat(32)}` as `0x${string}`;
    await Pet.create({petId, name: "Blaze", ownerClientIds: [], searchKey: "blaze"});
    const fixture = buildVerifiableFixture();
    const created = await createTagArtifact({
      petId,
      dogTagIdDec: dogTagIdField,
      dogTagIdField,
      root: fixture.root,
      protocolVersion: "dogtag-v2/1",
      schemaId: "https://dogtag.io/schemas/dog-profile/v1",
      leaves: fixture.leaves,
      reservedLeafHashes: fixture.reservedLeafHashes,
      expectedIdentityLeaves: [],
      source: "issued_here",
      issuerClone: ISSUER_CLONE,
      now: Math.floor(Date.now() / 1000),
    } satisfies CreateTagArtifactInput);
    expect(created.ok).toBe(true);
    vi.mocked(readDelegationLeaves).mockRejectedValue(new Error("RPC unreachable"));

    const token = await seedConfirmedAddSession(petId, dogTagIdField, commitment);
    const res = await publicStatusGET(new Request(`https://vet.example.com/d/${token}/status`), {params: Promise.resolve({token})});
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe("added");
    expect(body.bundle).toBeUndefined();
    expect(body.bundleUnavailable).toBe(true);
  });
});
