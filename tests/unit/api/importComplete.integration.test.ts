import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import mongoose from "mongoose";
import {buildMerkle, dogTagIdField, hashLeaf, hexToBytes, toHex32, TypeTag, type TypedScalar} from "@dogtag/standard";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.10V item 6 TRANSITION (orchestrator ruling, P2 finding) - `POST /i/:token/complete` against
 * the REAL route handler, a real ephemeral mongod, AND mocked chain reads (this route's own chain
 * checks must succeed for a completion to go through at all - `unconfiguredMobileTagChainDeps`
 * would make every attempt `chain_unreadable`, which cannot prove "round-trips unchanged"). Mocks
 * `lib/chainRead.ts` directly, the same `vi.mock` convention this suite already uses for `@/auth` -
 * this repo has no OTHER route-level test exercising a real on-chain-configured completion, so this
 * file is also new coverage for that gap, not only the alias fix.
 *
 * THE central proof this file exists for: a WP4.9M-shaped request body (`leaves` only, no
 * `disclosed`, no `obfuscatedLeafHashes` - exactly what dogtag-ios's shipped `ArtifactShareEngine`
 * sends today) still completes an import successfully, byte-for-byte as it did before this wave.
 *
 * ISOLATION: own ephemeral mongod, port 44133 (44117-44132 already taken by sibling suites - see
 * `tests/unit/api/verifyRedactedArtifact.integration.test.ts`'s own doc comment).
 */
vi.mock("@/lib/chainRead", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chainRead")>();
  return {
    ...actual,
    readProfileRoot: vi.fn(),
    readRootIssuer: vi.fn(),
    readIsValidRoot: vi.fn(),
  };
});

import * as chainRead from "@/lib/chainRead";
import {connectToDatabase} from "@/lib/db";
import {POST as completePOST} from "@/app/i/[token]/complete/route";
import {ArtifactImportSession} from "@/lib/models/ArtifactImportSession";
import {ClinicSettings} from "@/lib/models/ClinicSettings";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {TagArtifact, type TagArtifactDoc} from "@/lib/models/TagArtifact";

const MONGO_PORT = 44_133;
const OUR_CLONE = "0x5bd5048125f223100a2753a740f34d044ab493b";
const FOREIGN_CLONE = "0x57f8786264c55cdd8f3ece0ba177f6ad2df90e0";
const SBT_ADDRESS = "0x276101555b2cd92be0fb85ff908e02281d6a3cf9";
const FACTORY_ADDRESS = "0x1bd279d3c9fc85eb3e4d304ee890435b6a5ca4cc";
const DOG_TAG_ID_DEC = "42";
const DOG_TAG_ID_FIELD = dogTagIdField(DOG_TAG_ID_DEC).toString(10);
// The ROUTE (unlike the pure completeImport tests elsewhere) always uses the REAL wall clock
// (Date.now()) internally - exp must be relative to it, never a fixed historical constant.
function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-import-complete");
  process.env.MONGODB_URI = ephemeral.uri;
  process.env.DOGTAG_SBT_ADDRESS = SBT_ADDRESS;
  process.env.VET_ISSUER_FACTORY_ADDRESS = FACTORY_ADDRESS;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  expect(mongoose.connection.name).toBe("dogtag-vet-import-complete");
  // The route's chain-deps selection ALSO requires settings?.cloneAddress (on top of the two env
  // vars above) before it will use the real (mocked) chain reads - see the route's own comment on
  // why: `mongoMobileTagChainDeps` itself does not need this clinic's own clone, but the route
  // gates on it anyway (mirrors completeImport's isReclaim calculation elsewhere). A singleton, so
  // seeded once here rather than per-test.
  await ClinicSettings.create({_id: "singleton", cloneAddress: OUR_CLONE, businessProfile: {name: "Example Vet Clinic"}});
}, 30_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Promise.all([Pet.deleteMany({}), TagArtifact.deleteMany({}), ArtifactImportSession.deleteMany({})]);
  vi.mocked(chainRead.readProfileRoot).mockReset();
  vi.mocked(chainRead.readRootIssuer).mockReset();
  vi.mocked(chainRead.readIsValidRoot).mockReset();
});

/** A genuine, hashLeaf/buildMerkle-verifiable fixture, keyed to DOG_TAG_ID_FIELD. */
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

async function seedSession(token: string, fixture: {root: string}, issuerClone: `0x${string}` = FOREIGN_CLONE as `0x${string}`) {
  await ArtifactImportSession.create({token, clinicName: "Example Vet Clinic", cloneAddress: OUR_CLONE, exp: nowSecs() + 600});
  vi.mocked(chainRead.readProfileRoot).mockResolvedValue(fixture.root);
  vi.mocked(chainRead.readRootIssuer).mockResolvedValue(issuerClone);
  vi.mocked(chainRead.readIsValidRoot).mockResolvedValue(true);
}

function postComplete(token: string, body: unknown) {
  return completePOST(
    new Request(`https://vet.example.com/i/${token}/complete`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    }),
    {params: Promise.resolve({token})},
  );
}

describe("POST /i/:token/complete - leaves/disclosed transition (WP4.10V item 6)", () => {
  it("a WP4.9M-shaped body (leaves only, no disclosed, no obfuscatedLeafHashes) completes successfully - a new pet with a FULL (non-partial) artifact", async () => {
    const fixture = buildVerifiableFixture();
    const token = "a".repeat(32);
    await seedSession(token, fixture);

    const res = await postComplete(token, {
      dogTagIdDec: DOG_TAG_ID_DEC,
      leaves: fixture.leaves,
      reservedLeafHashes: fixture.reservedLeafHashes,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);

    const pet = await Pet.findOne({petId: body.petId}).lean<PetDoc>();
    expect(pet?.name).toBe("Rex");
    expect(pet?.species).toBe("dog");

    const artifact = await TagArtifact.findOne({petId: body.petId}).lean<TagArtifactDoc>();
    expect(artifact?.leaves).toEqual(fixture.leaves);
    expect(artifact?.obfuscatedLeafHashes).toEqual([]);
    expect(artifact?.dogTagIdField).toBe(DOG_TAG_ID_FIELD);
  });

  it("a WP4.10M-shaped body (disclosed instead of leaves, plus obfuscatedLeafHashes) stores honest PARTIAL custody", async () => {
    const fixture = buildVerifiableFixture();
    const maskedLeaf = fixture.leaves[1]!; // species masked
    const disclosedLeaf = fixture.leaves[0]!; // name disclosed
    const maskedHash = toHex32(hashLeaf(maskedLeaf.keyPath, hexToBytes(maskedLeaf.saltHex), {tag: maskedLeaf.tag, value: maskedLeaf.value} as TypedScalar));
    const token = "b".repeat(32);
    await seedSession(token, fixture);

    const res = await postComplete(token, {
      dogTagIdDec: DOG_TAG_ID_DEC,
      disclosed: [disclosedLeaf],
      obfuscatedLeafHashes: [maskedHash],
      reservedLeafHashes: fixture.reservedLeafHashes,
      schemaId: "https://dogtag.io/schemas/dog-profile/v1",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const artifact = await TagArtifact.findOne({petId: body.petId}).lean<TagArtifactDoc>();
    expect(artifact?.leaves).toEqual([disclosedLeaf]);
    expect(artifact?.obfuscatedLeafHashes).toEqual([maskedHash]);
    expect(artifact?.schemaId).toBe("https://dogtag.io/schemas/dog-profile/v1");
    expect(artifact?.root).toBe(fixture.root.toLowerCase());

    // Pet-page treatment (item 6): this pet's species is honestly left BLANK - the masked leaf's
    // VALUE was never disclosed to this clinic, only its hash, so mergeVerifiedAttributes never
    // had a "dog" to fill in from.
    const pet = await Pet.findOne({petId: body.petId}).lean<PetDoc>();
    expect(pet?.species).toBeUndefined();
  });

  it("a body sending BOTH leaves and disclosed with DIFFERING content is rejected (400) before ever reaching the chain", async () => {
    const fixture = buildVerifiableFixture();
    const token = "c".repeat(32);
    await seedSession(token, fixture);

    const res = await postComplete(token, {
      dogTagIdDec: DOG_TAG_ID_DEC,
      leaves: [fixture.leaves[0]],
      disclosed: [fixture.leaves[1]],
      reservedLeafHashes: fixture.reservedLeafHashes,
    });
    expect(res.status).toBe(400);
    expect(chainRead.readProfileRoot).not.toHaveBeenCalled();
  });
});
