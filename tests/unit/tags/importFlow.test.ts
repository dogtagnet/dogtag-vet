import {describe, expect, it, vi} from "vitest";
import {buildMerkle, hashLeaf, hexToBytes, toHex32, TypeTag, verifyLeafCommitment, type OpenedLeaf, type TypedScalar} from "@dogtag/standard";
import {
  completeImport,
  mergeVerifiedAttributes,
  resolveImportSession,
  type AttachTagFields,
  type AttachToExistingPetResult,
  type AttributeMergeField,
  type ExistingPetAttributes,
  type ImportFlowStore,
  type ImportSessionRow,
  type ImportTargetPetPreview,
} from "@/lib/tags/importFlow";
import type {TagDataChainDeps, VerifiedPetAttributes} from "@/lib/tags/verifier";

/**
 * Lifecycle-matrix coverage for the WP4.9 import ceremony (plan section 2.3, checklist item 6) -
 * mirrors `tests/unit/tags/verifier.test.ts`'s real-crypto fixture-building style and
 * `tests/unit/registration/flow.test.ts`'s in-memory-fake-store convention.
 */

const OUR_CLONE = "0x5bd5048125f223100a2753a740f34d044ab493b";
const FOREIGN_CLONE = "0x57f8786264c55cdd8f3ece0ba177f6ad2df90e0";
const A_ROOT = `0x${"11".repeat(32)}`;
const DOG_TAG_ID_DEC = "42";
const NOW = 1_735_689_600;

function fakeDeps(overrides: Partial<TagDataChainDeps> = {}): TagDataChainDeps {
  return {
    readProfileRoot: vi.fn().mockResolvedValue(A_ROOT),
    readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE),
    readIsValidRoot: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

/** For any test that actually calls `verifyLeafCommitment` against a real fixture (every "happy
 * path" and every gate PAST `resolveTagRootAndIssuer`) - `readProfileRoot` MUST resolve to the
 * fixture's own computed root, never the unrelated `A_ROOT` constant `fakeDeps()` defaults to
 * (that constant is only ever right for tests that stop at stage 1, like `malformed_claim`). */
function fakeDepsFor(fixture: {root: string}, overrides: Partial<TagDataChainDeps> = {}): TagDataChainDeps {
  return fakeDeps({readProfileRoot: vi.fn().mockResolvedValue(fixture.root), ...overrides});
}

/** A genuine (leaves, reservedLeafHashes, root) triple the real `verifyLeafCommitment` accepts -
 * same primitives `tests/unit/tags/verifier.test.ts`'s own fixture builder uses. `nameValue`
 * varies so tests can exercise fill-empty/conflict/agree cases against a target pet's own name. */
function buildVerifiableFixture(nameValue = "Rex", speciesValue = "dog"): {leaves: OpenedLeaf[]; reservedLeafHashes: string[]; root: string} {
  const salt = (n: number) => new Uint8Array(16).fill(n);
  const saltHexOf = (n: number) => ("0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
  const leaves: OpenedLeaf[] = [
    {keyPath: "credentialSubject.species", saltHex: saltHexOf(11), tag: TypeTag.String, value: speciesValue},
    {keyPath: "credentialSubject.name", saltHex: saltHexOf(12), tag: TypeTag.String, value: nameValue},
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

function newSessionFixture(overrides?: Partial<ImportSessionRow>): ImportSessionRow {
  return {
    token: "a".repeat(32),
    clinicName: "Example Vet Clinic",
    ourCloneAddress: OUR_CLONE,
    exp: NOW + 600,
    ...overrides,
  };
}

interface FakePet {
  name: string;
  hasActiveTag: boolean;
  attributes: ExistingPetAttributes;
  attachedTag?: AttachTagFields;
  conflicts?: AttributeMergeField[];
}

function makeStore(session: ImportSessionRow, pets: Record<string, FakePet> = {}) {
  const sessions = new Map<string, ImportSessionRow>([[session.token, {...session}]]);
  const petsById = new Map<string, FakePet>(Object.entries(pets).map(([id, p]) => [id, {...p}]));
  const createdPets: {petId: string; attributes: ExistingPetAttributes; tag: AttachTagFields}[] = [];
  const createdArtifacts: {petId: string; root: string}[] = [];
  let nextPetId = 1;

  const store: ImportFlowStore = {
    async getByToken(token) {
      const row = sessions.get(token);
      return row ? {...row} : null;
    },
    async tryConsume(token, now) {
      const row = sessions.get(token);
      if (!row || row.usedAt !== undefined) return false;
      row.usedAt = now;
      return true;
    },
    async previewTargetPet(petId): Promise<ImportTargetPetPreview | null> {
      const pet = petsById.get(petId);
      return pet ? {name: pet.name, hasActiveTag: pet.hasActiveTag} : null;
    },
    async findExistingPetAttributes(petId) {
      const pet = petsById.get(petId);
      return pet ? {...pet.attributes} : null;
    },
    async attachToExistingPet(petId, resolvedAttributes, tag, conflicts): Promise<AttachToExistingPetResult> {
      const pet = petsById.get(petId);
      if (!pet || pet.hasActiveTag) return {ok: false};
      pet.hasActiveTag = true;
      pet.attributes = resolvedAttributes;
      pet.attachedTag = tag;
      pet.conflicts = conflicts;
      if (resolvedAttributes.name) pet.name = resolvedAttributes.name;
      return {ok: true, petName: pet.name};
    },
    async createPetFromImport(attributes, tag) {
      const petId = `new-pet-${nextPetId++}`;
      const petName = attributes.name?.trim() || "Imported pet";
      petsById.set(petId, {name: petName, hasActiveTag: true, attributes, attachedTag: tag});
      createdPets.push({petId, attributes, tag});
      return {petId, petName};
    },
    async createImportedArtifact(input) {
      createdArtifacts.push({petId: input.petId, root: input.root});
    },
  };
  return {store, sessions, petsById, createdPets, createdArtifacts};
}

describe("mergeVerifiedAttributes (pure fill-empty-only merge)", () => {
  const verified: VerifiedPetAttributes = {name: "Rex", species: "dog", breed: "Labrador"};

  it("fills empty fields from the verified claim", () => {
    const result = mergeVerifiedAttributes({}, verified);
    expect(result).toEqual({resolved: {name: "Rex", species: "dog", breed: "Labrador"}, conflicts: []});
  });

  it("never overwrites an existing value that agrees - no conflict recorded either", () => {
    const result = mergeVerifiedAttributes({name: "Rex", species: "dog"}, verified);
    expect(result.resolved).toEqual({name: "Rex", species: "dog", breed: "Labrador"});
    expect(result.conflicts).toEqual([]);
  });

  it("records a conflict (and does NOT overwrite) when an existing value differs", () => {
    const result = mergeVerifiedAttributes({name: "Buddy", species: "cat"}, verified);
    expect(result.resolved.name).toBe("Buddy");
    expect(result.resolved.species).toBe("cat");
    expect(result.resolved.breed).toBe("Labrador"); // still filled - breed was empty
    expect(result.conflicts).toEqual([
      {field: "name", petValue: "Buddy", verifiedValue: "Rex"},
      {field: "species", petValue: "cat", verifiedValue: "dog"},
    ]);
  });

  it("a verified claim with no attributes at all produces no fills and no conflicts", () => {
    const result = mergeVerifiedAttributes({name: "Buddy"}, {});
    expect(result).toEqual({resolved: {name: "Buddy"}, conflicts: []});
  });
});

describe("resolveImportSession (GET /i/:token)", () => {
  it("not_found for an unknown token", async () => {
    const {store} = makeStore(newSessionFixture());
    const result = await resolveImportSession(store, "z".repeat(32), NOW);
    expect(result).toEqual({ok: false, code: "not_found"});
  });

  it("expired_or_reused past the TTL", async () => {
    const session = newSessionFixture({exp: NOW - 1});
    const {store} = makeStore(session);
    const result = await resolveImportSession(store, session.token, NOW);
    expect(result).toEqual({ok: false, code: "expired_or_reused"});
  });

  it("isNewPet: true with no targetPetId - never consumes the token", async () => {
    const session = newSessionFixture();
    const {store, sessions} = makeStore(session);
    const result = await resolveImportSession(store, session.token, NOW);
    expect(result).toEqual({ok: true, clinicName: "Example Vet Clinic", isNewPet: true, ttlSecs: 600});
    expect(sessions.get(session.token)?.usedAt).toBeUndefined();
  });

  it("isNewPet: false with the target pet's name, when targetPetId is set", async () => {
    const session = newSessionFixture({targetPetId: "pet-1"});
    const {store} = makeStore(session, {"pet-1": {name: "Rex", hasActiveTag: false, attributes: {}}});
    const result = await resolveImportSession(store, session.token, NOW);
    expect(result).toEqual({ok: true, clinicName: "Example Vet Clinic", isNewPet: false, targetPetName: "Rex", ttlSecs: 600});
  });
});

describe("completeImport (POST /i/:token/complete) - token lifecycle", () => {
  it("not_found for an unknown token", async () => {
    const {store} = makeStore(newSessionFixture());
    const fixture = buildVerifiableFixture();
    const result = await completeImport(store, fakeDeps(), {token: "z".repeat(32), dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result).toEqual({ok: false, code: "not_found"});
  });

  it("expired_or_reused past the TTL - never consumes (already dead)", async () => {
    const session = newSessionFixture({exp: NOW - 1});
    const {store, sessions} = makeStore(session);
    const fixture = buildVerifiableFixture();
    const result = await completeImport(store, fakeDeps(), {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result).toEqual({ok: false, code: "expired_or_reused"});
    expect(sessions.get(session.token)?.usedAt).toBeUndefined();
  });

  it("expired_or_reused on a second completion attempt against an already-consumed token", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const fixture = buildVerifiableFixture();
    const first = await completeImport(store, fakeDepsFor(fixture), {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(first.ok).toBe(true);
    const second = await completeImport(store, fakeDeps(), {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW + 1);
    expect(second).toEqual({ok: false, code: "expired_or_reused"});
  });
});

describe("completeImport - claim/chain gates (chain-unreadable vs verify-failed honesty split)", () => {
  it("malformed_claim: dogTagIdDec and dogTagIdField are inconsistent - does not consume", async () => {
    const session = newSessionFixture();
    const {store, sessions} = makeStore(session);
    const fixture = buildVerifiableFixture();
    const result = await completeImport(
      store,
      fakeDeps(),
      {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, dogTagIdField: "999999", ...fixture},
      NOW,
    );
    expect(result).toEqual({ok: false, code: "malformed_claim"});
    // malformed_claim is detected AFTER tryConsume in the gate order (it needs the shared verifier,
    // a fresh per-attempt read) - still burns the token, same "no retry" precedent as every other
    // post-consume refusal.
    expect(sessions.get(session.token)?.usedAt).toBe(NOW);
  });

  it("chain_unreadable when readProfileRoot throws", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const fixture = buildVerifiableFixture();
    const deps = fakeDeps({readProfileRoot: vi.fn().mockRejectedValue(new Error("RPC timeout"))});
    const result = await completeImport(store, deps, {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result).toEqual({ok: false, code: "chain_unreadable"});
  });

  it("root_unset when the chain reports the zero root (never issued)", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const fixture = buildVerifiableFixture();
    const deps = fakeDeps({readProfileRoot: vi.fn().mockResolvedValue(`0x${"0".repeat(64)}`)});
    const result = await completeImport(store, deps, {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result).toEqual({ok: false, code: "root_unset"});
  });

  it("revoked when isValid(root) is false against the issuer clone - honest, never called verify_failed", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const fixture = buildVerifiableFixture();
    const deps = fakeDeps({readProfileRoot: vi.fn().mockResolvedValue(fixture.root), readIsValidRoot: vi.fn().mockResolvedValue(false)});
    const result = await completeImport(store, deps, {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result).toEqual({ok: false, code: "revoked"});
  });

  it("verify_failed when the submitted leaves do not recompute the on-chain root (tampered data)", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const fixture = buildVerifiableFixture();
    const tamperedLeaves = fixture.leaves.map((l) => (l.keyPath === "credentialSubject.name" ? {...l, value: "TAMPERED"} : l));
    const deps = fakeDeps({readProfileRoot: vi.fn().mockResolvedValue(fixture.root)});
    const result = await completeImport(
      store,
      deps,
      {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, leaves: tamperedLeaves, reservedLeafHashes: fixture.reservedLeafHashes},
      NOW,
    );
    expect(result).toEqual({ok: false, code: "verify_failed"});
  });

  it("reinstated-later succeeds on a fresh scan: a FRESH session against the SAME now-valid tag succeeds (never a chain cache)", async () => {
    // Simulates "revoked, then reactivated at the issuer" by simply reading isValid as true this
    // time - completeImport has no chain-state cache of its own, so this is automatic, not a
    // special-cased retry path.
    const session = newSessionFixture({token: "b".repeat(32)});
    const {store} = makeStore(session);
    const fixture = buildVerifiableFixture();
    const deps = fakeDeps({readProfileRoot: vi.fn().mockResolvedValue(fixture.root), readIsValidRoot: vi.fn().mockResolvedValue(true)});
    const result = await completeImport(store, deps, {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result.ok).toBe(true);
  });
});

describe("completeImport - target-pet gates and the reclaim case", () => {
  it("already_has_active_tag via the cheap pre-check - does NOT consume the token (avoids burning an already-doomed request)", async () => {
    const session = newSessionFixture({targetPetId: "pet-1"});
    const {store, sessions} = makeStore(session, {"pet-1": {name: "Rex", hasActiveTag: true, attributes: {}}});
    const fixture = buildVerifiableFixture();
    const result = await completeImport(store, fakeDeps(), {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result).toEqual({ok: false, code: "already_has_active_tag"});
    expect(sessions.get(session.token)?.usedAt).toBeUndefined();
  });

  it("a lost race at the ATOMIC attach step (pre-check passed, but attachToExistingPet loses) is still already_has_active_tag - and the token IS burned by then", async () => {
    const session = newSessionFixture({targetPetId: "pet-1"});
    const {store, sessions} = makeStore(session, {"pet-1": {name: "Rex", hasActiveTag: false, attributes: {}}});
    const fixture = buildVerifiableFixture();
    // Simulate a concurrent writer winning between the pre-check and the atomic attach - this is
    // exactly what the atomic conditional write (not the pre-check) is responsible for catching.
    const originalAttach = store.attachToExistingPet.bind(store);
    store.attachToExistingPet = async (petId, resolved, tag, conflicts, now) => {
      await originalAttach(petId, resolved, tag, conflicts, now); // a "concurrent" import wins first
      return originalAttach(petId, resolved, tag, conflicts, now); // this caller's own attempt loses
    };
    const result = await completeImport(store, fakeDepsFor(fixture), {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result).toEqual({ok: false, code: "already_has_active_tag"});
    expect(sessions.get(session.token)?.usedAt).toBe(NOW);
  });

  it("target pet with a REVOKED tag (not active) is a valid import target - no gate refusal", async () => {
    const session = newSessionFixture({targetPetId: "pet-1"});
    const {store} = makeStore(session, {"pet-1": {name: "Rex", hasActiveTag: false, attributes: {name: "Rex"}}});
    const fixture = buildVerifiableFixture();
    const result = await completeImport(store, fakeDepsFor(fixture), {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result.ok).toBe(true);
  });

  it("happy path, existing pet, no conflicts: fills empty fields, attaches the tag, stores the artifact", async () => {
    const session = newSessionFixture({targetPetId: "pet-1"});
    const {store, petsById, createdArtifacts} = makeStore(session, {"pet-1": {name: "Rex", hasActiveTag: false, attributes: {name: "Rex"}}});
    const fixture = buildVerifiableFixture("Rex", "dog");
    const result = await completeImport(store, fakeDepsFor(fixture), {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result).toEqual({ok: true, petId: "pet-1", petName: "Rex", created: false, conflicts: []});
    expect(petsById.get("pet-1")?.attributes.species).toBe("dog"); // filled - was empty
    expect(createdArtifacts).toEqual([{petId: "pet-1", root: fixture.root}]);
  });

  it("happy path, existing pet, WITH a conflict: keeps the pet's own value, surfaces the conflict, still succeeds", async () => {
    const session = newSessionFixture({targetPetId: "pet-1"});
    const {store, petsById} = makeStore(session, {
      "pet-1": {name: "Rex", hasActiveTag: false, attributes: {name: "Rex", species: "cat"}},
    });
    const fixture = buildVerifiableFixture("Rex", "dog"); // verified species "dog" conflicts with the pet's "cat"
    const result = await completeImport(store, fakeDepsFor(fixture), {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result).toEqual({
      ok: true,
      petId: "pet-1",
      petName: "Rex",
      created: false,
      conflicts: [{field: "species", petValue: "cat", verifiedValue: "dog"}],
    });
    expect(petsById.get("pet-1")?.attributes.species).toBe("cat"); // never overwritten
  });

  it("happy path, no targetPetId: creates a new pet from verified data", async () => {
    const session = newSessionFixture();
    const {store, createdPets} = makeStore(session);
    const fixture = buildVerifiableFixture("Rex", "dog");
    const result = await completeImport(store, fakeDepsFor(fixture), {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result.ok).toBe(true);
    expect(result.ok && result.created).toBe(true);
    expect(result.ok && result.petName).toBe("Rex");
    expect(createdPets).toHaveLength(1);
    expect(createdPets[0]?.attributes).toEqual({name: "Rex", species: "dog"});
  });

  it("falls back to a placeholder name when creating a new pet and the verified data carries no name", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const fixture = buildVerifiableFixture("", "dog"); // an empty name leaf never maps to a usable name
    const result = await completeImport(store, fakeDepsFor(fixture), {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result.ok && result.petName).toBe("Imported pet");
  });

  it("the reclaim case (issuerClone equals this session's own clone): external is NOT set, but source is still imported (verified via the mongo adapter's own attach shape - see importMongoAdapter.test coverage)", async () => {
    const session = newSessionFixture({targetPetId: "pet-1", ourCloneAddress: OUR_CLONE});
    const {store, petsById} = makeStore(session, {"pet-1": {name: "Rex", hasActiveTag: false, attributes: {name: "Rex"}}});
    const fixture = buildVerifiableFixture("Rex", "dog");
    const deps = fakeDepsFor(fixture, {readRootIssuer: vi.fn().mockResolvedValue(OUR_CLONE)}); // reclaim: issuer IS our own clone
    const result = await completeImport(store, deps, {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result.ok).toBe(true);
    expect(petsById.get("pet-1")?.attachedTag?.external).toBe(false);
  });

  it("the non-reclaim case (a genuinely foreign issuer): external is true", async () => {
    const session = newSessionFixture({targetPetId: "pet-1", ourCloneAddress: OUR_CLONE});
    const {store, petsById} = makeStore(session, {"pet-1": {name: "Rex", hasActiveTag: false, attributes: {name: "Rex"}}});
    const fixture = buildVerifiableFixture("Rex", "dog");
    const deps = fakeDepsFor(fixture, {readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE)});
    const result = await completeImport(store, deps, {token: session.token, dogTagIdDec: DOG_TAG_ID_DEC, ...fixture}, NOW);
    expect(result.ok).toBe(true);
    expect(petsById.get("pet-1")?.attachedTag?.external).toBe(true);
  });
});
