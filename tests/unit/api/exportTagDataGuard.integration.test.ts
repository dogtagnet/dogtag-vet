import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.9V FIX ROUND 1 (D3, belt-and-suspenders) - `POST /api/pets/:id/export-tag-data`'s own
 * `artifact.root !== pet.dogTag?.root?.toLowerCase()` refusal, exercised against the REAL route
 * handler (not just the underlying model/flow functions `tagArtifact.integration.test.ts` already
 * covers), the same "call the actual route, not just the helper" pattern
 * `issuanceRouteGuards.integration.test.ts` established for the WP4.7A role gates.
 *
 * The primary D3 fix (custodial-bind creates `active: false`; only `linkPetDogTag` promotes, at
 * confirm) should make this state unreachable in ordinary operation - this guard exists anyway, as
 * an explicit, tested invariant rather than an implicit one, in case any future write path ever
 * forgets it (a stale relink, a hand-repaired document, ...).
 *
 * ISOLATION: own ephemeral mongod, port 44128 (44117-44127 already taken by sibling suites - see
 * each file's own ISOLATION note, most recently `tests/unit/models/importSession.integration.test
 * .ts`'s 44127).
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));

import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {POST} from "@/app/api/pets/[id]/export-tag-data/route";
import {Pet} from "@/lib/models/Pet";
import {TagArtifact} from "@/lib/models/TagArtifact";

const MONGO_PORT = 44_128;
let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-export-guard");
  // The route handler calls `connectToDatabase()` itself (not a directly-injected connection), so
  // this test drives the SAME cached-connection path `issuanceRouteGuards.integration.test.ts`
  // already established for calling real route handlers in this suite.
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  expect(mongoose.connection.name).toBe("dogtag-vet-export-guard");
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

function postRequest(petId: string) {
  return POST(new Request(`https://vet.example.com/api/pets/${petId}/export-tag-data`, {method: "POST"}), {
    params: Promise.resolve({id: petId}),
  });
}

describe("POST /api/pets/:id/export-tag-data - the artifact.root === pet.dogTag.root guard (D3)", () => {
  it("refuses (400) when the pet's ACTIVE artifact's root diverges from pet.dogTag.root", async () => {
    staffSession();
    const anchoredRoot = `0x${"11".repeat(32)}`;
    const unanchoredRoot = `0x${"22".repeat(32)}`;
    await Pet.create({
      petId: "pet-mismatch",
      name: "Mismatch Pet",
      ownerClientIds: [],
      dogTag: {dogTagIdDec: "42", dogTagIdField: "123456", root: anchoredRoot, status: "active", cloneAddress: CLONE},
      searchKey: "mismatch pet",
    });
    // Simulate the exact divergence PROBE C names directly - an "active" artifact sitting on a
    // root that is NOT what the pet record says is actually anchored.
    await TagArtifact.create({
      petId: "pet-mismatch",
      dogTagIdField: "123456",
      root: unanchoredRoot,
      protocolVersion: "dogtag-v2/1",
      leaves: [],
      reservedLeafHashes: [],
      source: "issued_here",
      issuerClone: CLONE,
      verifiedAt: 1_700_000_000,
      active: true,
    });

    const res = await postRequest("pet-mismatch");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/mid-reissue and not yet anchored/i);
  });

  it("succeeds (201) when the active artifact's root matches pet.dogTag.root", async () => {
    staffSession();
    const root = `0x${"33".repeat(32)}`;
    await Pet.create({
      petId: "pet-ok",
      name: "OK Pet",
      ownerClientIds: [],
      dogTag: {dogTagIdDec: "42", dogTagIdField: "123456", root, status: "active", cloneAddress: CLONE},
      searchKey: "ok pet",
    });
    await TagArtifact.create({
      petId: "pet-ok",
      dogTagIdField: "123456",
      root,
      protocolVersion: "dogtag-v2/1",
      leaves: [],
      reservedLeafHashes: [],
      source: "issued_here",
      issuerClone: CLONE,
      verifiedAt: 1_700_000_000,
      active: true,
    });

    const res = await postRequest("pet-ok");
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.qr).toContain("/e/");
  });
});
