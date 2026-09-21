import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import mongoose from "mongoose";
import {buildMerkle, hashLeaf, hexToBytes, toHex32, TypeTag, verifyLeafCommitment, type OpenedLeaf, type TypedScalar} from "@dogtag/standard";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";
import {completeImport, resolveImportSession} from "@/lib/tags/importFlow";
import {mongoImportStore} from "@/lib/tags/importMongoAdapter";
import {ArtifactImportSession} from "@/lib/models/ArtifactImportSession";
import {TagArtifact} from "@/lib/models/TagArtifact";
import {Pet} from "@/lib/models/Pet";
import type {TagDataChainDeps} from "@/lib/tags/verifier";

/**
 * `mongoImportStore` end to end against a REAL ephemeral mongod - proves the production adapter's
 * own query shapes, and specifically the REAL atomicity of `attachToExistingPet`'s conditional
 * write (an in-memory fake, tests/unit/tags/importFlow.test.ts, can only simulate a race by
 * monkey-patching; this proves it against genuine concurrent Mongo writes). Never the live
 * manual-E2E database on 127.0.0.1:27500 - see this repo's own CRITICAL LIVE-DB RULE.
 *
 * ISOLATION: own ephemeral mongod on a freshly OS-reserved free port (see
 * tests/unit/helpers/ephemeralMongod.ts - each spawn reserves a currently-free port by binding
 * and releasing a throwaway socket, unique across concurrent processes including two whole
 * copies of this suite running at once, and retries on a genuine bind collision, so no fixed
 * port or manual coordination between sibling suites is needed).
 */
const OUR_CLONE = "0x5bd5048125f223100a2753a740f34d044ab493b";
const FOREIGN_CLONE = "0x57f8786264c55cdd8f3ece0ba177f6ad2df90e0";
const DOG_TAG_ID_DEC = "42";
const NOW = 1_700_000_000;

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod("dogtag-vet-import-session");
  await mongoose.connect(ephemeral.uri);
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(ephemeral.port);
  expect(mongoose.connection.name).toBe("dogtag-vet-import-session");
  await ArtifactImportSession.init();
  await TagArtifact.init();
}, 90_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Promise.all([Pet.deleteMany({}), TagArtifact.deleteMany({}), ArtifactImportSession.deleteMany({})]);
});

/** `extra` (WP4.12, Kenneth issue 2) optionally adds color/registrationId/registrationAuthority
 * leaves on top of the species/name pair every existing caller already relies on - a purely
 * additive, default-valued parameter, so every pre-WP4.12V call site above (0 or 2 positional
 * args) is unaffected. */
function buildVerifiableFixture(
  nameValue = "Rex",
  speciesValue = "dog",
  extra: {color?: string; registrationId?: string; registrationAuthority?: string} = {},
): {leaves: OpenedLeaf[]; reservedLeafHashes: string[]; root: string} {
  const salt = (n: number) => new Uint8Array(16).fill(n);
  const saltHexOf = (n: number) => ("0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
  const leaves: OpenedLeaf[] = [
    {keyPath: "credentialSubject.species", saltHex: saltHexOf(11), tag: TypeTag.String, value: speciesValue},
    {keyPath: "credentialSubject.name", saltHex: saltHexOf(12), tag: TypeTag.String, value: nameValue},
  ];
  if (extra.color !== undefined) {
    leaves.push({keyPath: "credentialSubject.color", saltHex: saltHexOf(13), tag: TypeTag.String, value: extra.color});
  }
  if (extra.registrationId !== undefined) {
    leaves.push({keyPath: "credentialSubject.registrationId", saltHex: saltHexOf(14), tag: TypeTag.String, value: extra.registrationId});
  }
  if (extra.registrationAuthority !== undefined) {
    leaves.push({
      keyPath: "credentialSubject.registrationAuthority",
      saltHex: saltHexOf(15),
      tag: TypeTag.String,
      value: extra.registrationAuthority,
    });
  }
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

function fakeDepsFor(fixture: {root: string}, issuerClone = FOREIGN_CLONE): TagDataChainDeps {
  return {
    readProfileRoot: vi.fn().mockResolvedValue(fixture.root),
    readRootIssuer: vi.fn().mockResolvedValue(issuerClone),
    readIsValidRoot: vi.fn().mockResolvedValue(true),
  };
}

async function seedPet(
  petId: string,
  options: {status?: "active" | "revoked"; dogTagIdDec?: string; color?: string} = {},
) {
  await Pet.create({
    petId,
    name: "Rex",
    color: options.color,
    ownerClientIds: [],
    dogTag: options.status ? {dogTagIdDec: options.dogTagIdDec ?? "1", dogTagIdField: "1", root: `0x${"9".repeat(64)}`, status: options.status, cloneAddress: OUR_CLONE} : {},
    searchKey: "rex",
  });
}

async function seedImportSession(token: string, targetPetId?: string) {
  await ArtifactImportSession.create({token, targetPetId, clinicName: "Example Vet Clinic", cloneAddress: OUR_CLONE, exp: NOW + 600});
}

describe("mongoImportStore + completeImport against a real ephemeral mongod", () => {
  it("happy path end to end: existing pet target, fills empty attributes, stores the artifact", async () => {
    await seedPet("pet-1");
    await seedImportSession("a".repeat(32), "pet-1");
    const fixture = buildVerifiableFixture("Rex", "dog");

    const result = await completeImport(
      mongoImportStore,
      fakeDepsFor(fixture),
      {token: "a".repeat(32), dogTagIdDec: DOG_TAG_ID_DEC, ...fixture},
      NOW,
    );
    expect(result).toMatchObject({ok: true, petId: "pet-1", petName: "Rex", created: false, conflicts: []});

    const pet = await Pet.findOne({petId: "pet-1"}).lean();
    expect(pet?.species).toBe("dog");
    expect(pet?.dogTag.root).toBe(fixture.root.toLowerCase());
    expect(pet?.dogTag.external).toBe(true); // FOREIGN_CLONE issuer - not a reclaim

    const artifact = await TagArtifact.findOne({petId: "pet-1"}).lean();
    expect(artifact?.source).toBe("imported");
    expect(artifact?.active).toBe(true);
  });

  it("happy path end to end: no target - creates a new pet from verified data", async () => {
    await seedImportSession("b".repeat(32));
    const fixture = buildVerifiableFixture("Buddy", "cat");

    const result = await completeImport(mongoImportStore, fakeDepsFor(fixture), {token: "b".repeat(32), dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.petName).toBe("Buddy");

    const pet = await Pet.findOne({petId: result.petId}).lean();
    expect(pet?.species).toBe("cat");
    expect(pet?.dogTag.external).toBe(true);
  });

  it("the reclaim case: issuerClone equals this session's own clone - external is false, source is still imported", async () => {
    await seedPet("pet-reclaim");
    await seedImportSession("c".repeat(32), "pet-reclaim");
    const fixture = buildVerifiableFixture("Rex", "dog");

    const result = await completeImport(mongoImportStore, fakeDepsFor(fixture, OUR_CLONE), {token: "c".repeat(32), dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result.ok).toBe(true);

    const pet = await Pet.findOne({petId: "pet-reclaim"}).lean();
    expect(pet?.dogTag.external).toBeFalsy();
    const artifact = await TagArtifact.findOne({petId: "pet-reclaim"}).lean();
    expect(artifact?.source).toBe("imported");
  });

  it("already_has_active_tag: the atomic conditional write itself refuses a target that already has an active tag (not just the pre-check)", async () => {
    await seedPet("pet-taken", {status: "active", dogTagIdDec: "7"});
    await seedImportSession("d".repeat(32), "pet-taken");
    const fixture = buildVerifiableFixture();

    const result = await completeImport(mongoImportStore, fakeDepsFor(fixture), {token: "d".repeat(32), dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result).toEqual({ok: false, code: "already_has_active_tag"});
    // The tag is untouched.
    const pet = await Pet.findOne({petId: "pet-taken"}).lean();
    expect(pet?.dogTag.dogTagIdDec).toBe("7");
  });

  it("a target pet with a REVOKED tag is a valid import target (not blocked)", async () => {
    await seedPet("pet-revoked-target", {status: "revoked", dogTagIdDec: "7"});
    await seedImportSession("e".repeat(32), "pet-revoked-target");
    const fixture = buildVerifiableFixture();

    const result = await completeImport(mongoImportStore, fakeDepsFor(fixture), {token: "e".repeat(32), dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result.ok).toBe(true);
    const pet = await Pet.findOne({petId: "pet-revoked-target"}).lean();
    expect(pet?.dogTag.root).toBe(fixture.root.toLowerCase());
    expect(pet?.dogTag.status).toBe("active");
  });

  it("a REAL concurrent race at the atomic attach: two DIFFERENT import tokens targeting the SAME pet - exactly one succeeds, the other gets already_has_active_tag", async () => {
    await seedPet("pet-race");
    await seedImportSession("f".repeat(32), "pet-race");
    await seedImportSession("1".repeat(32), "pet-race");
    const fixtureA = buildVerifiableFixture("Rex", "dog");
    const fixtureB = buildVerifiableFixture("Rex", "cat"); // different root (different species leaf)

    const [first, second] = await Promise.all([
      completeImport(mongoImportStore, fakeDepsFor(fixtureA), {token: "f".repeat(32), dogTagIdDec: DOG_TAG_ID_DEC, ...fixtureA}, NOW),
      completeImport(mongoImportStore, fakeDepsFor(fixtureB), {token: "1".repeat(32), dogTagIdDec: DOG_TAG_ID_DEC, ...fixtureB}, NOW),
    ]);
    const outcomes = [first, second];
    const winners = outcomes.filter((r) => r.ok);
    const losers = outcomes.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toEqual({ok: false, code: "already_has_active_tag"});

    // Exactly one TagArtifact was ever created for this pet - the loser's createImportedArtifact
    // was never reached (attach happens before the artifact write, per completeImport's own
    // ordering) - a lost race here must never leave an orphaned artifact for data that never
    // actually landed on the pet.
    const artifactCount = await TagArtifact.countDocuments({petId: "pet-race"});
    expect(artifactCount).toBe(1);
  });

  it("resolveImportSession (GET) against real data: reports the existing target's name, non-consuming", async () => {
    await seedPet("pet-preview");
    await seedImportSession("2".repeat(32), "pet-preview");
    const result = await resolveImportSession(mongoImportStore, "2".repeat(32), NOW);
    expect(result).toEqual({ok: true, clinicName: "Example Vet Clinic", isNewPet: false, targetPetName: "Rex", ttlSecs: 600});
    const session = await ArtifactImportSession.findOne({token: "2".repeat(32)}).lean();
    expect(session?.usedAt).toBeUndefined();
  });

  /**
   * WP4.12V item 7/8 - proves `importMongoAdapter.ts`'s three new call sites actually persist
   * color/registrationId/registrationAuthority through a REAL write, not just that
   * `mergeVerifiedAttributes` (tests/unit/tags/importFlow.test.ts, entirely in-memory) computes the
   * right `resolved`/`conflicts` values in isolation. `importMongoAdapter.ts` is not literally named
   * in plan section 3.2 item 7 but is required for the merge to have any effect at all - this is the
   * test that closes that gap empirically.
   */
  it("fills empty color/registrationId/registrationAuthority on an existing pet target from the verified claim", async () => {
    await seedPet("pet-profile-leaves");
    await seedImportSession("3".repeat(32), "pet-profile-leaves");
    const fixture = buildVerifiableFixture("Rex", "dog", {
      color: "brown",
      registrationId: "SGP-DOG-0042",
      registrationAuthority: "AVS Singapore",
    });

    const result = await completeImport(
      mongoImportStore,
      fakeDepsFor(fixture),
      {token: "3".repeat(32), dogTagIdDec: DOG_TAG_ID_DEC, ...fixture},
      NOW,
    );
    expect(result).toMatchObject({ok: true, petId: "pet-profile-leaves", conflicts: []});

    const pet = await Pet.findOne({petId: "pet-profile-leaves"}).lean();
    expect(pet?.color).toBe("brown");
    expect(pet?.registrationId).toBe("SGP-DOG-0042");
    expect(pet?.registrationAuthority).toBe("AVS Singapore");
  });

  it("a pre-existing color on the target pet is KEPT (never overwritten) and surfaced as a real, persisted importConflicts entry", async () => {
    await seedPet("pet-color-conflict", {color: "black"});
    await seedImportSession("4".repeat(32), "pet-color-conflict");
    const fixture = buildVerifiableFixture("Rex", "dog", {color: "brown"});

    const result = await completeImport(
      mongoImportStore,
      fakeDepsFor(fixture),
      {token: "4".repeat(32), dogTagIdDec: DOG_TAG_ID_DEC, ...fixture},
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conflicts).toEqual([{field: "color", petValue: "black", verifiedValue: "brown"}]);

    const pet = await Pet.findOne({petId: "pet-color-conflict"}).lean();
    expect(pet?.color).toBe("black"); // this clinic's own value, never overwritten
    expect(pet?.dogTag.importConflicts?.fields).toEqual([{field: "color", petValue: "black", verifiedValue: "brown"}]);
  });

  it("creating a brand-new pet from an import carries color/registrationId/registrationAuthority onto the new Pet document", async () => {
    await seedImportSession("5".repeat(32));
    const fixture = buildVerifiableFixture("Buddy", "cat", {registrationId: "SGP-CAT-0007"});

    const result = await completeImport(mongoImportStore, fakeDepsFor(fixture), {token: "5".repeat(32), dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pet = await Pet.findOne({petId: result.petId}).lean();
    expect(pet?.registrationId).toBe("SGP-CAT-0007");
    expect(pet?.color).toBeUndefined();
    expect(pet?.registrationAuthority).toBeUndefined();
  });
});
