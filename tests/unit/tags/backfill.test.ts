import {describe, expect, it, vi} from "vitest";
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
import {backfillTagArtifacts, type BackfillMintSession, type BackfillPet, type BackfillStore} from "@/lib/tags/backfill";
import {verifyForProtocolVersion, type CreateTagArtifactResult} from "@/lib/tags/artifact";

/**
 * WP4.9 checklist item 3c + item 7 - the backfill migration's own pure logic, against an
 * in-memory fake store (plan 2.5's "vet unit" bucket). A separate ephemeral-mongod integration
 * test (tests/unit/models/backfill.integration.test.ts) proves the REAL Mongo adapter end to end,
 * including the "corrupted-session report case" against genuine documents.
 */

const DOG_TAG_ID_DEC = "42";
const DOG_TAG_ID_FIELD = dogTagIdField(DOG_TAG_ID_DEC).toString(10);

function buildVerifiableFixture(nameValue = "Rex"): {leaves: OpenedLeaf[]; reservedLeafHashes: string[]; root: string} {
  const salt = (n: number) => new Uint8Array(16).fill(n);
  const saltHexOf = (n: number) => ("0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
  const leaves: OpenedLeaf[] = [
    {keyPath: "credentialSubject.species", saltHex: saltHexOf(11), tag: TypeTag.String, value: "dog"},
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

/** The default `createArtifact` fake actually RUNS the real, pure `verifyForProtocolVersion`
 * dispatch (no I/O - the same dispatch the real `createTagArtifact` uses) before deciding ok/not-
 * ok, only fabricating the DB-persistence half of a real insert. This matters: a fake that always
 * returns `{ok: true}` regardless of input would make the "corrupted session"/"unsupported
 * protocol version" tests below pass for the wrong reason (the fake, not `backfillTagArtifacts`'s
 * own logic, would be what makes them look like they work) - tests/unit/models/
 * tagArtifact.integration.test.ts already covers createTagArtifact's OWN write behavior for real. */
function fakeStore(overrides: Partial<BackfillStore> = {}): BackfillStore & {createArtifactCalls: unknown[]} {
  const createArtifactCalls: unknown[] = [];
  return {
    createArtifactCalls,
    listPetsWithRoot: vi.fn().mockResolvedValue([]),
    findActiveArtifactRoot: vi.fn().mockResolvedValue(null),
    findBoundMintSessionByRoot: vi.fn().mockResolvedValue(null),
    async createArtifact(input) {
      createArtifactCalls.push(input);
      const verified = verifyForProtocolVersion(input);
      if (!verified.ok) return verified;
      return {ok: true, artifact: {} as never};
    },
    ...overrides,
  };
}

function pet(overrides: Partial<BackfillPet> = {}): BackfillPet {
  return {petId: "pet-1", dogTagIdDec: DOG_TAG_ID_DEC, dogTagIdField: DOG_TAG_ID_FIELD, root: `0x${"ab".repeat(32)}`, cloneAddress: "0xClone", ...overrides};
}

function session(overrides: Partial<BackfillMintSession> = {}, fixture = buildVerifiableFixture()): BackfillMintSession {
  return {
    dogTagIdDec: DOG_TAG_ID_DEC,
    dogTagIdField: DOG_TAG_ID_FIELD,
    boundLeaves: fixture.leaves,
    reservedLeafHashes: fixture.reservedLeafHashes,
    identityLeaves: [],
    protocolVersion: "dogtag-v2/1",
    ...overrides,
  };
}

describe("backfillTagArtifacts", () => {
  it("skips a pet whose active artifact already matches dogTag.root - no session lookup, no write", async () => {
    const p = pet();
    const store = fakeStore({
      listPetsWithRoot: vi.fn().mockResolvedValue([p]),
      findActiveArtifactRoot: vi.fn().mockResolvedValue(p.root.toLowerCase()),
    });
    const report = await backfillTagArtifacts(store, 1_700_000_000);
    expect(report).toMatchObject({scanned: 1, alreadyCovered: 1, inserted: 0, mismatches: []});
    expect(report.details).toEqual([{petId: "pet-1", root: p.root, outcome: "already_covered"}]);
    expect(store.findBoundMintSessionByRoot).not.toHaveBeenCalled();
    expect(store.createArtifactCalls).toEqual([]);
  });

  it("inserts a genuinely new artifact for a pet with a matching bound MintSession", async () => {
    const fixture = buildVerifiableFixture();
    const p = pet({root: fixture.root});
    const store = fakeStore({
      listPetsWithRoot: vi.fn().mockResolvedValue([p]),
      findBoundMintSessionByRoot: vi.fn().mockResolvedValue(session({}, fixture)),
    });
    const report = await backfillTagArtifacts(store, 1_700_000_000);
    expect(report).toMatchObject({scanned: 1, alreadyCovered: 0, inserted: 1, mismatches: []});
    expect(report.details).toEqual([{petId: "pet-1", root: fixture.root, outcome: "inserted"}]);
    expect(store.createArtifactCalls).toEqual([
      {
        petId: "pet-1",
        dogTagIdDec: DOG_TAG_ID_DEC,
        dogTagIdField: DOG_TAG_ID_FIELD,
        root: fixture.root,
        protocolVersion: "dogtag-v2/1",
        leaves: fixture.leaves,
        reservedLeafHashes: fixture.reservedLeafHashes,
        expectedIdentityLeaves: [],
        source: "issued_here",
        issuerClone: "0xClone",
        now: 1_700_000_000,
      },
    ]);
  });

  it("external pet: source is 'imported' and expectedIdentityLeaves is the self-check subset, not session.identityLeaves", async () => {
    const fixture = buildVerifiableFixture();
    const identityLeaf: OpenedLeaf = {keyPath: "owner.identity.fullName", saltHex: `0x${"cc".repeat(16)}`, tag: TypeTag.String, value: "Jane Doe"};
    const leavesWithIdentity = [...fixture.leaves, identityLeaf];
    // Recompute a genuinely valid root over the identity-inclusive leaf set for this test.
    const reservedFields = fixture.reservedLeafHashes.map((h) => BigInt(h));
    const leafFields = leavesWithIdentity.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), {tag: l.tag, value: l.value} as TypedScalar));
    const root = toHex32(buildMerkle([...reservedFields, ...leafFields]).root);

    const p = pet({root, external: true});
    const store = fakeStore({
      listPetsWithRoot: vi.fn().mockResolvedValue([p]),
      findBoundMintSessionByRoot: vi.fn().mockResolvedValue(
        session({boundLeaves: leavesWithIdentity, identityLeaves: [{keyPath: "should.never.be.used", saltHex: "0x00", tag: TypeTag.Null, value: ""}]}),
      ),
    });
    const report = await backfillTagArtifacts(store, 1_700_000_000);
    expect(report.inserted).toBe(1);
    const call = store.createArtifactCalls[0] as {source: string; expectedIdentityLeaves: OpenedLeaf[]};
    expect(call.source).toBe("imported");
    expect(call.expectedIdentityLeaves).toEqual([identityLeaf]);
  });

  it("reports a mismatch (never writes) when no MintSession carries the pet's root", async () => {
    const p = pet();
    const store = fakeStore({listPetsWithRoot: vi.fn().mockResolvedValue([p])});
    const report = await backfillTagArtifacts(store, 1_700_000_000);
    expect(report).toMatchObject({scanned: 1, alreadyCovered: 0, inserted: 0});
    expect(report.mismatches).toEqual([{petId: "pet-1", root: p.root, reason: "no MintSession on file carries this pet's dogTag.root"}]);
    expect(store.createArtifactCalls).toEqual([]);
  });

  it("the corrupted-session report case: a MintSession's stored leaves no longer recompute to its own root - reported, never auto-fixed", async () => {
    const fixture = buildVerifiableFixture();
    const p = pet({root: fixture.root});
    // Corruption: the session's boundLeaves have been tampered (a value changed after the fact) -
    // the SAME root is still claimed, but it no longer recomputes.
    const corrupted = fixture.leaves.map((l) => (l.keyPath === "credentialSubject.name" ? {...l, value: "TAMPERED"} : l));
    const store = fakeStore({
      listPetsWithRoot: vi.fn().mockResolvedValue([p]),
      findBoundMintSessionByRoot: vi.fn().mockResolvedValue(session({boundLeaves: corrupted}, fixture)),
    });
    const report = await backfillTagArtifacts(store, 1_700_000_000);
    expect(report.inserted).toBe(0);
    expect(report.mismatches).toEqual([
      {petId: "pet-1", root: fixture.root, reason: "this session's stored root/leaves no longer recompute (leaf_commitment_invalid)"},
    ]);
  });

  it("reports a mismatch for an unsupported protocolVersion, never writes", async () => {
    const fixture = buildVerifiableFixture();
    const p = pet({root: fixture.root});
    const store = fakeStore({
      listPetsWithRoot: vi.fn().mockResolvedValue([p]),
      findBoundMintSessionByRoot: vi.fn().mockResolvedValue(session({protocolVersion: "dogtag-v3/1"}, fixture)),
    });
    const report = await backfillTagArtifacts(store, 1_700_000_000);
    expect(report.mismatches).toEqual([
      {petId: "pet-1", root: fixture.root, reason: "this session's stored root/leaves no longer recompute (unsupported_protocol_version)"},
    ]);
  });

  it("createArtifact throwing (e.g. the cross-pet-root invariant) is caught and reported as a mismatch, never propagated", async () => {
    const fixture = buildVerifiableFixture();
    const p = pet({root: fixture.root});
    const store = fakeStore({
      listPetsWithRoot: vi.fn().mockResolvedValue([p]),
      findBoundMintSessionByRoot: vi.fn().mockResolvedValue(session({}, fixture)),
      createArtifact: vi.fn().mockRejectedValue(new Error("root already belongs to a different pet")),
    });
    const report = await backfillTagArtifacts(store, 1_700_000_000);
    expect(report.mismatches).toEqual([{petId: "pet-1", root: fixture.root, reason: "createArtifact threw: root already belongs to a different pet"}]);
  });

  it("createArtifact refusing (ok:false) is reported as a mismatch with the exact reason", async () => {
    const fixture = buildVerifiableFixture();
    const p = pet({root: fixture.root});
    const refusal: CreateTagArtifactResult = {ok: false, reason: "leaf_commitment_invalid"};
    const store = fakeStore({
      listPetsWithRoot: vi.fn().mockResolvedValue([p]),
      findBoundMintSessionByRoot: vi.fn().mockResolvedValue(session({}, fixture)),
      createArtifact: vi.fn().mockResolvedValue(refusal),
    });
    const report = await backfillTagArtifacts(store, 1_700_000_000);
    expect(report.mismatches).toEqual([
      {petId: "pet-1", root: fixture.root, reason: "this session's stored root/leaves no longer recompute (leaf_commitment_invalid)"},
    ]);
  });

  it("aggregates multiple pets in one run correctly", async () => {
    const covered = pet({petId: "pet-covered", root: `0x${"01".repeat(32)}`});
    const freshFixture = buildVerifiableFixture("Fresh");
    const fresh = pet({petId: "pet-fresh", root: freshFixture.root});
    const missing = pet({petId: "pet-missing", root: `0x${"02".repeat(32)}`});
    const store = fakeStore({
      listPetsWithRoot: vi.fn().mockResolvedValue([covered, fresh, missing]),
      findActiveArtifactRoot: vi.fn().mockImplementation(async (petId: string) => (petId === "pet-covered" ? covered.root.toLowerCase() : null)),
      findBoundMintSessionByRoot: vi.fn().mockImplementation(async (root: string) => (root === freshFixture.root ? session({}, freshFixture) : null)),
    });
    const report = await backfillTagArtifacts(store, 1_700_000_000);
    expect(report).toMatchObject({scanned: 3, alreadyCovered: 1, inserted: 1, mismatches: [{petId: "pet-missing", root: missing.root, reason: expect.any(String)}]});
  });

  describe("dryRun", () => {
    it("predicts 'inserted' without ever calling store.createArtifact", async () => {
      const fixture = buildVerifiableFixture();
      const p = pet({root: fixture.root});
      const store = fakeStore({
        listPetsWithRoot: vi.fn().mockResolvedValue([p]),
        findBoundMintSessionByRoot: vi.fn().mockResolvedValue(session({}, fixture)),
      });
      const report = await backfillTagArtifacts(store, 1_700_000_000, {dryRun: true});
      expect(report).toMatchObject({dryRun: true, inserted: 1, mismatches: []});
      expect(store.createArtifactCalls).toEqual([]);
    });

    it("still correctly predicts the corrupted-session mismatch without calling store.createArtifact", async () => {
      const fixture = buildVerifiableFixture();
      const p = pet({root: fixture.root});
      const corrupted = fixture.leaves.map((l) => (l.keyPath === "credentialSubject.name" ? {...l, value: "TAMPERED"} : l));
      const store = fakeStore({
        listPetsWithRoot: vi.fn().mockResolvedValue([p]),
        findBoundMintSessionByRoot: vi.fn().mockResolvedValue(session({boundLeaves: corrupted}, fixture)),
      });
      const report = await backfillTagArtifacts(store, 1_700_000_000, {dryRun: true});
      expect(report.mismatches).toHaveLength(1);
      expect(store.createArtifactCalls).toEqual([]);
    });

    it("still reports already_covered pets identically to a real run (a read, not a write)", async () => {
      const p = pet();
      const store = fakeStore({
        listPetsWithRoot: vi.fn().mockResolvedValue([p]),
        findActiveArtifactRoot: vi.fn().mockResolvedValue(p.root.toLowerCase()),
      });
      const report = await backfillTagArtifacts(store, 1_700_000_000, {dryRun: true});
      expect(report).toMatchObject({dryRun: true, alreadyCovered: 1, inserted: 0});
    });
  });
});
