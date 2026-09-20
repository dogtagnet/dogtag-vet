import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";
import mongoose from "mongoose";
import {randomUUID} from "node:crypto";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";
import {connectToDatabase} from "@/lib/db";
import {Pet, type PetDoc} from "@/lib/models/Pet";

/**
 * WP4.12V item 8 - back-compat proof for `Pet.color`/`registrationId`/`registrationAuthority`
 * (Kenneth issue 2), same reasoning and technique as `tests/unit/models/wp47BackCompat
 * .integration.test.ts`'s own doc comment: a raw `collection.insertOne` shaped exactly like a
 * pre-WP4.12V row (mongoose bakes schema defaults into a document at CREATE time, so a fresh
 * `.create()` would pass even a naive implementation - only bypassing mongoose's own
 * defaulting/casting via a raw insert actually exercises the read-back path a real upgrade hits)
 * must read back cleanly via BOTH `Pet.findOne` (the pet detail page, `GET /api/pets/:id`) and
 * `Pet.find` (the pet LIST route, `GET /api/pets`, and `TagIssueWizard`'s own pet picker) - "load
 * and list unchanged" per this wave's own instructions.
 *
 * A NEW file, not a new describe block inside `wp47BackCompat.integration.test.ts`: that file has
 * no `Pet` import and no `Pet.deleteMany` in its shared `afterEach` today, and its own precedent
 * (the WP4.13 Staff describe block) only ever extended a model ALREADY present there.
 *
 * ISOLATION: own ephemeral mongod, port 44135 (44134 is the highest port used by any OTHER
 * integration suite in this repo as of this wave; 44136 is
 * tests/unit/api/mintSessionResolveRoute.integration.test.ts's own port - see that file's doc
 * comment).
 */
const MONGO_PORT = 44_135;
let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-pet-profile-leaves");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  expect(mongoose.connection.name).toBe("dogtag-vet-pet-profile-leaves");
}, 90_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Pet.deleteMany({});
});

describe("Pet back-compat (WP4.12V - color/registrationId/registrationAuthority)", () => {
  it("a pre-WP4.12V row (raw insert, no new fields in storage) reads back via findOne with the new fields absent, existing fields intact", async () => {
    const petId = randomUUID();
    await Pet.collection.insertOne({
      petId,
      name: "Legacy Rex",
      species: "dog",
      breed: "Labrador",
      ownerClientIds: [],
      dogTag: {},
      searchKey: "legacy rex dog labrador",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const found = await Pet.findOne({petId}).lean<PetDoc>();
    expect(found).toBeDefined();
    expect(found!.name).toBe("Legacy Rex");
    expect(found!.species).toBe("dog");
    expect(found).not.toHaveProperty("color");
    expect(found).not.toHaveProperty("registrationId");
    expect(found).not.toHaveProperty("registrationAuthority");
  });

  it("the SAME legacy row reads back via find() (the list path GET /api/pets and TagIssueWizard's own pet picker both use) with the new fields absent", async () => {
    const petId = randomUUID();
    await Pet.collection.insertOne({
      petId,
      name: "Legacy Fido",
      ownerClientIds: [],
      dogTag: {},
      searchKey: "legacy fido",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const list = await Pet.find({petId}).lean<PetDoc[]>();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("Legacy Fido");
    expect(list[0]).not.toHaveProperty("color");
    expect(list[0]).not.toHaveProperty("registrationId");
    expect(list[0]).not.toHaveProperty("registrationAuthority");
  });

  it("a freshly created Pet row leaves color/registrationId/registrationAuthority unset when not supplied", async () => {
    const created = await Pet.create({name: "Fresh Pet", ownerClientIds: [], searchKey: "fresh pet"});
    const plain = created.toObject() as PetDoc;
    expect(plain.color).toBeUndefined();
    expect(plain.registrationId).toBeUndefined();
    expect(plain.registrationAuthority).toBeUndefined();
  });

  it("a freshly created Pet row with all three set round-trips them exactly through a real read-back", async () => {
    const petId = randomUUID();
    await Pet.create({
      petId,
      name: "Blaze",
      ownerClientIds: [],
      searchKey: "blaze",
      color: "brown",
      registrationId: "SGP-DOG-0042",
      registrationAuthority: "AVS Singapore",
    });

    const found = await Pet.findOne({petId}).lean<PetDoc>();
    expect(found?.color).toBe("brown");
    expect(found?.registrationId).toBe("SGP-DOG-0042");
    expect(found?.registrationAuthority).toBe("AVS Singapore");
  });
});
