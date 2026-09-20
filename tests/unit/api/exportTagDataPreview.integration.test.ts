import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import mongoose from "mongoose";
import {buildMerkle, hashLeaf, hexToBytes, toHex32, TypeTag, type TypedScalar} from "@dogtag/standard";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.10V item 4 - `POST /api/pets/:id/export-tag-data/preview`, the staff-only "Download JSON"/
 * "Copy JSON" data source, against the REAL route handler + a real ephemeral mongod (never the
 * live manual-E2E database on 127.0.0.1:27500).
 *
 * ISOLATION: own ephemeral mongod, port 44130 (44117-44129 already taken by sibling suites - see
 * `tests/unit/api/selfWalletRoute.integration.test.ts`'s own doc comment for the running registry).
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));

import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {POST} from "@/app/api/pets/[id]/export-tag-data/preview/route";
import {Pet} from "@/lib/models/Pet";
import {TagArtifact} from "@/lib/models/TagArtifact";

const MONGO_PORT = 44_130;
let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-export-preview");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  expect(mongoose.connection.name).toBe("dogtag-vet-export-preview");
}, 90_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Promise.all([Pet.deleteMany({}), TagArtifact.deleteMany({})]);
  vi.mocked(auth).mockReset();
});

const CLONE = "0x5bd5048125f223100a2753a740f34d044ab493b";

function staffSession() {
  vi.mocked(auth).mockResolvedValue({user: {staffId: "staff-1", email: "staff@example.com"}} as never);
}

function postRequest(petId: string, body?: unknown) {
  return POST(
    new Request(`https://vet.example.com/api/pets/${petId}/export-tag-data/preview`, {
      method: "POST",
      ...(body !== undefined ? {headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)} : {}),
    }),
    {params: Promise.resolve({id: petId})},
  );
}

/** A genuine, hashLeaf/buildMerkle-verifiable fixture (this route's own self-check needs one). */
function buildVerifiableFixture(): {leaves: {keyPath: string; saltHex: string; tag: TypeTag; value: string}[]; reservedLeafHashes: string[]; root: string} {
  const salt = (n: number) => new Uint8Array(16).fill(n);
  const saltHexOf = (n: number) => ("0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
  const leaves = [
    {keyPath: "credentialSubject.name", saltHex: saltHexOf(11), tag: TypeTag.String, value: "Rex"},
    {keyPath: "credentialSubject.species", saltHex: saltHexOf(12), tag: TypeTag.String, value: "dog"},
  ];
  const reservedLeafHashes = [
    toHex32(hashLeaf("owner.address", salt(201), {tag: TypeTag.Bytes, value: new Uint8Array([1])} as TypedScalar)),
    toHex32(hashLeaf("owner.consentKey", salt(202), {tag: TypeTag.Bytes, value: new Uint8Array([2])} as TypedScalar)),
    toHex32(hashLeaf("owner.secret", salt(203), {tag: TypeTag.Bytes, value: new Uint8Array([3])} as TypedScalar)),
  ];
  const reservedFields = reservedLeafHashes.map((h) => BigInt(h));
  const leafFields = leaves.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), {tag: l.tag, value: l.value} as TypedScalar));
  const root = toHex32(buildMerkle([...reservedFields, ...leafFields]).root);
  return {leaves, reservedLeafHashes, root};
}

async function seedPetAndArtifact(petId: string) {
  const fixture = buildVerifiableFixture();
  await Pet.create({
    petId,
    name: "Rex",
    ownerClientIds: [],
    dogTag: {dogTagIdDec: "42", dogTagIdField: "999999", root: fixture.root, status: "active", cloneAddress: CLONE},
    searchKey: "rex",
  });
  await TagArtifact.create({
    petId,
    dogTagIdDec: "42",
    dogTagIdField: "999999",
    root: fixture.root,
    protocolVersion: "dogtag-v2/1",
    schemaId: "https://dogtag.io/schemas/dog-profile/v1",
    leaves: fixture.leaves,
    reservedLeafHashes: fixture.reservedLeafHashes,
    source: "issued_here",
    issuerClone: CLONE,
    verifiedAt: 1_700_000_000,
    active: true,
  });
  return fixture;
}

describe("POST /api/pets/:id/export-tag-data/preview", () => {
  it("401 when not signed in", async () => {
    const res = await postRequest("pet-1");
    expect(res.status).toBe(401);
  });

  it("400 when the pet has no tag data on file yet", async () => {
    staffSession();
    await Pet.create({petId: "pet-notag", name: "No Tag", ownerClientIds: [], searchKey: "no tag"});
    const res = await postRequest("pet-notag");
    expect(res.status).toBe(400);
  });

  it("no mask: returns the full disclosed set, obfuscatedLeafHashes empty - byte-identical to what /e/:token would eventually serve", async () => {
    staffSession();
    const fixture = await seedPetAndArtifact("pet-full");
    const res = await postRequest("pet-full");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disclosed).toEqual(fixture.leaves);
    expect(body.obfuscatedLeafHashes).toEqual([]);
    expect(body.root).toBe(fixture.root);
    expect(body.petName).toBe("Rex");
    expect(typeof body.chainId).toBe("number");
  });

  it("with a valid mask: moves the named leaf into obfuscatedLeafHashes as its recomputed hash", async () => {
    staffSession();
    const fixture = await seedPetAndArtifact("pet-masked");
    const res = await postRequest("pet-masked", {mask: ["credentialSubject.species"]});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disclosed).toEqual([fixture.leaves[0]]);
    expect(body.obfuscatedLeafHashes).toHaveLength(1);
  });

  it("400 with a field error for an unknown keyPath in the mask", async () => {
    staffSession();
    await seedPetAndArtifact("pet-badmask");
    const res = await postRequest("pet-badmask", {mask: ["credentialSubject.bogus"]});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.details.fieldErrors.mask).toEqual([{keyPath: "credentialSubject.bogus", reason: "unknown_keypath"}]);
  });

  it("never creates an ArtifactExportSession row - no token, no ceremony, no one-time-use machinery for this staff-only action", async () => {
    staffSession();
    await seedPetAndArtifact("pet-nosession");
    const res = await postRequest("pet-nosession");
    expect(res.status).toBe(200);
    const {ArtifactExportSession} = await import("@/lib/models/ArtifactExportSession");
    expect(await ArtifactExportSession.countDocuments({})).toBe(0);
  });
});
