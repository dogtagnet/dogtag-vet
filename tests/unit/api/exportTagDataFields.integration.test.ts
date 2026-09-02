import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import mongoose from "mongoose";
import {buildMerkle, hashLeaf, hexToBytes, toHex32, TypeTag, type TypedScalar} from "@dogtag/standard";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.10V item 4 - `GET /api/pets/:id/export-tag-data/fields`, the staff-only field-picker data
 * source, against the REAL route handler + a real ephemeral mongod.
 *
 * ISOLATION: own ephemeral mongod, port 44131 (44117-44130 already taken by sibling suites - see
 * `tests/unit/api/exportTagDataPreview.integration.test.ts`'s own doc comment).
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));

import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {GET} from "@/app/api/pets/[id]/export-tag-data/fields/route";
import {recomputeLeafHash} from "@/lib/tags/exportFlow";
import {Pet} from "@/lib/models/Pet";
import {TagArtifact} from "@/lib/models/TagArtifact";

const MONGO_PORT = 44_131;
let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-export-fields");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  expect(mongoose.connection.name).toBe("dogtag-vet-export-fields");
}, 30_000);

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

function getRequest(petId: string) {
  return GET(new Request(`https://vet.example.com/api/pets/${petId}/export-tag-data/fields`), {params: Promise.resolve({id: petId})});
}

describe("GET /api/pets/:id/export-tag-data/fields", () => {
  it("401 when not signed in", async () => {
    const res = await getRequest("pet-1");
    expect(res.status).toBe(401);
  });

  it("404 when the pet has no tag data on file yet", async () => {
    staffSession();
    await Pet.create({petId: "pet-notag", name: "No Tag", ownerClientIds: [], searchKey: "no tag"});
    const res = await getRequest("pet-notag");
    expect(res.status).toBe(404);
  });

  it("lists every disclosed leaf with its precomputed leafHash and display group, plus reservedCount", async () => {
    staffSession();
    const salt = (n: number) => new Uint8Array(16).fill(n);
    const saltHexOf = (n: number) => ("0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
    const nameLeaf = {keyPath: "credentialSubject.name", saltHex: saltHexOf(11), tag: TypeTag.String, value: "Rex"};
    const identityLeaf = {keyPath: "owner.identity.fullName", saltHex: saltHexOf(12), tag: TypeTag.String, value: "Jane Doe"};
    const leaves = [nameLeaf, identityLeaf];
    const reservedLeafHashes = [
      toHex32(hashLeaf("owner.address", salt(201), {tag: TypeTag.Bytes, value: new Uint8Array([1])} as TypedScalar)),
      toHex32(hashLeaf("owner.consentKey", salt(202), {tag: TypeTag.Bytes, value: new Uint8Array([2])} as TypedScalar)),
      toHex32(hashLeaf("owner.secret", salt(203), {tag: TypeTag.Bytes, value: new Uint8Array([3])} as TypedScalar)),
    ];
    const reservedFields = reservedLeafHashes.map((h) => BigInt(h));
    const leafFields = leaves.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), {tag: l.tag, value: l.value} as TypedScalar));
    const root = toHex32(buildMerkle([...reservedFields, ...leafFields]).root);

    await Pet.create({
      petId: "pet-fields",
      name: "Rex",
      ownerClientIds: [],
      dogTag: {dogTagIdDec: "42", dogTagIdField: "999999", root, status: "active", cloneAddress: CLONE},
      searchKey: "rex",
    });
    await TagArtifact.create({
      petId: "pet-fields",
      dogTagIdDec: "42",
      dogTagIdField: "999999",
      root,
      protocolVersion: "dogtag-v2/1",
      leaves,
      reservedLeafHashes,
      source: "issued_here",
      issuerClone: CLONE,
      verifiedAt: 1_700_000_000,
      active: true,
    });

    const res = await getRequest("pet-fields");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reservedCount).toBe(3);
    expect(body.fields).toEqual([
      {keyPath: "credentialSubject.name", tag: TypeTag.String, value: "Rex", leafHash: recomputeLeafHash(nameLeaf), group: "pet"},
      {keyPath: "owner.identity.fullName", tag: TypeTag.String, value: "Jane Doe", leafHash: recomputeLeafHash(identityLeaf), group: "owner_identity"},
    ]);
  });
});
