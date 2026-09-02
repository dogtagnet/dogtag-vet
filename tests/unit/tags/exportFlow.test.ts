import {describe, expect, it} from "vitest";
import {buildMerkle, hashLeaf, hexToBytes, toHex32, TypeTag, type TypedScalar} from "@dogtag/standard";
import {resolveAndConsumeExport, type ExportedArtifactRow, type ExportFlowStore, type ExportSessionRow} from "@/lib/tags/exportFlow";

const NOW = 1_735_689_600;

/** A genuine, hashLeaf/buildMerkle-verifiable (leaves, reservedLeafHashes, root) triple - the same
 * fixture-building convention every other test touching `verifyLeafCommitment`/`verifyRedactedArtifact`
 * in this repo already uses (`tests/unit/tags/backfill.test.ts`, `tests/unit/models/
 * tagArtifact.integration.test.ts`, `e2e/tag-custody.spec.ts`). WP4.10V item 3's self-check
 * (`resolveAndConsumeExport` now runs `verifyRedactedArtifact` on the payload before serving it)
 * means an arbitrary, non-recomputing `root` - fine before this wave, since nothing here ever
 * recomputed it - now makes every fixture fail as `internal_error`, so this file needs REAL
 * cryptographic fixtures, not placeholder strings.
 */
function buildVerifiableFixture(): {
  leaves: {keyPath: string; saltHex: string; tag: TypeTag; value: string}[];
  reservedLeafHashes: string[];
  root: string;
} {
  const salt = (n: number) => new Uint8Array(16).fill(n);
  const saltHexOf = (n: number) => ("0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
  const leaves: {keyPath: string; saltHex: string; tag: TypeTag; value: string}[] = [
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

/** The hash a masked leaf would recompute to - what `resolveAndConsumeExport` is expected to put
 * in `obfuscatedLeafHashes` for it. */
function leafHashOf(leaf: {keyPath: string; saltHex: string; tag: TypeTag; value: string}): string {
  return toHex32(hashLeaf(leaf.keyPath, hexToBytes(leaf.saltHex), {tag: leaf.tag, value: leaf.value} as TypedScalar));
}

const FIXTURE = buildVerifiableFixture();

function newSessionFixture(overrides?: Partial<ExportSessionRow>): ExportSessionRow {
  return {
    token: "a".repeat(32),
    petId: "pet-1",
    root: FIXTURE.root,
    exp: NOW + 600,
    ...overrides,
  };
}

function newArtifactFixture(overrides?: Partial<ExportedArtifactRow>): ExportedArtifactRow {
  return {
    protocolVersion: "dogtag-v2/1",
    schemaId: "https://dogtag.io/schemas/dog-profile/v1",
    dogTagIdDec: "42",
    dogTagIdField: "999999",
    root: FIXTURE.root,
    leaves: FIXTURE.leaves,
    obfuscatedLeafHashes: [],
    reservedLeafHashes: FIXTURE.reservedLeafHashes,
    issuerClone: "0x5bd5048125f223100a2753a740f34d044ab493b",
    active: true,
    ...overrides,
  };
}

/** In-memory `ExportFlowStore` - no live database, mirroring
 * `tests/unit/registration/flow.test.ts`'s `makeStore` convention exactly. */
function makeStore(
  session: ExportSessionRow,
  options: {
    artifact?: ExportedArtifactRow | null;
    pet?: {name: string; dogTagStatus?: "active" | "revoked"} | null;
    clinicName?: string;
  } = {},
) {
  const sessions = new Map<string, ExportSessionRow>([[session.token, {...session}]]);
  const artifact = options.artifact === undefined ? newArtifactFixture() : options.artifact;
  const pet = options.pet === undefined ? {name: "Rex", dogTagStatus: "active" as const} : options.pet;

  const store: ExportFlowStore = {
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
    async findArtifactByPetAndRoot(petId, root) {
      if (!artifact) return null;
      return artifact.root.toLowerCase() === root.toLowerCase() && petId === session.petId ? {...artifact} : null;
    },
    async findPetForExport() {
      return pet ? {...pet} : null;
    },
    async getClinicName() {
      return options.clinicName;
    },
  };
  return {store, sessions};
}

describe("resolveAndConsumeExport (GET /e/:token)", () => {
  it("happy path: returns the active artifact's full payload (disclosed = everything, obfuscatedLeafHashes empty) and burns the token", async () => {
    const session = newSessionFixture();
    const {store, sessions} = makeStore(session, {clinicName: "Example Vet Clinic"});

    const result = await resolveAndConsumeExport(store, session.token, NOW);
    expect(result).toEqual({
      ok: true,
      data: {
        protocolVersion: "dogtag-v2/1",
        schemaId: "https://dogtag.io/schemas/dog-profile/v1",
        dogTagIdDec: "42",
        dogTagIdField: "999999",
        root: FIXTURE.root,
        disclosed: FIXTURE.leaves,
        obfuscatedLeafHashes: [],
        reservedLeafHashes: FIXTURE.reservedLeafHashes,
        issuerClone: "0x5bd5048125f223100a2753a740f34d044ab493b",
        petName: "Rex",
        clinicName: "Example Vet Clinic",
      },
    });
    expect(sessions.get(session.token)?.usedAt).toBe(NOW);
  });

  it("falls back to an empty clinicName when the clinic has not set a display name", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session, {clinicName: undefined});
    const result = await resolveAndConsumeExport(store, session.token, NOW);
    expect(result.ok).toBe(true);
    expect(result.ok && result.data.clinicName).toBe("");
  });

  it("not_found for an unknown token", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const result = await resolveAndConsumeExport(store, "b".repeat(32), NOW);
    expect(result).toEqual({ok: false, code: "not_found"});
  });

  it("expired_or_reused once naturally expired - and does not consume it (already dead)", async () => {
    const session = newSessionFixture({exp: NOW - 1});
    const {store, sessions} = makeStore(session);
    const result = await resolveAndConsumeExport(store, session.token, NOW);
    expect(result).toEqual({ok: false, code: "expired_or_reused"});
    expect(sessions.get(session.token)?.usedAt).toBeUndefined();
  });

  it("expired_or_reused on a second fetch against an already-consumed token", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const first = await resolveAndConsumeExport(store, session.token, NOW);
    expect(first.ok).toBe(true);
    const second = await resolveAndConsumeExport(store, session.token, NOW + 1);
    expect(second).toEqual({ok: false, code: "expired_or_reused"});
  });

  it("a lost tryConsume race (concurrent fetch already won) is expired_or_reused, never double-delivers the payload", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const originalTryConsume = store.tryConsume.bind(store);
    store.tryConsume = async (token, now) => {
      await originalTryConsume(token, now); // a "concurrent" request wins the race first
      return originalTryConsume(token, now); // this caller's own attempt now loses
    };
    const result = await resolveAndConsumeExport(store, session.token, NOW);
    expect(result).toEqual({ok: false, code: "expired_or_reused"});
  });

  it("superseded when the artifact this session was created for no longer exists at all", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session, {artifact: null});
    const result = await resolveAndConsumeExport(store, session.token, NOW);
    expect(result).toEqual({ok: false, code: "superseded"});
  });

  it("superseded when the artifact exists but has since been superseded (active: false) - the token is still burned", async () => {
    const session = newSessionFixture();
    const {store, sessions} = makeStore(session, {artifact: newArtifactFixture({active: false})});
    const result = await resolveAndConsumeExport(store, session.token, NOW);
    expect(result).toEqual({ok: false, code: "superseded"});
    expect(sessions.get(session.token)?.usedAt).toBe(NOW); // burned, no retry with the same token
  });

  it("revoked when the pet's tag status is revoked - the token is still burned", async () => {
    const session = newSessionFixture();
    const {store, sessions} = makeStore(session, {pet: {name: "Rex", dogTagStatus: "revoked"}});
    const result = await resolveAndConsumeExport(store, session.token, NOW);
    expect(result).toEqual({ok: false, code: "revoked"});
    expect(sessions.get(session.token)?.usedAt).toBe(NOW);
  });

  it("a revoked refusal burns the token permanently - a second attempt (even if the tag were reactivated) is expired_or_reused, not re-evaluated", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session, {pet: {name: "Rex", dogTagStatus: "revoked"}});
    await resolveAndConsumeExport(store, session.token, NOW);
    const second = await resolveAndConsumeExport(store, session.token, NOW + 1);
    expect(second).toEqual({ok: false, code: "expired_or_reused"});
  });
});

describe("resolveAndConsumeExport - masked export (WP4.10V item 3)", () => {
  it("a session's mask moves the named leaf out of disclosed and into obfuscatedLeafHashes, as its RECOMPUTED hash - root is unchanged", async () => {
    const masked = FIXTURE.leaves.find((l) => l.keyPath === "credentialSubject.species")!;
    const session = newSessionFixture({mask: ["credentialSubject.species"]});
    const {store} = makeStore(session);

    const result = await resolveAndConsumeExport(store, session.token, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.disclosed).toEqual([FIXTURE.leaves[0]]);
    expect(result.data.obfuscatedLeafHashes).toEqual([leafHashOf(masked)]);
    expect(result.data.root).toBe(FIXTURE.root); // masking never moves the root
  });

  it("masking every leaf still verifies - disclosed: [], obfuscatedLeafHashes holds every hash", async () => {
    const session = newSessionFixture({mask: FIXTURE.leaves.map((l) => l.keyPath)});
    const {store} = makeStore(session);

    const result = await resolveAndConsumeExport(store, session.token, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.disclosed).toEqual([]);
    expect(new Set(result.data.obfuscatedLeafHashes)).toEqual(new Set(FIXTURE.leaves.map(leafHashOf)));
  });

  it("an empty mask behaves exactly like no mask at all - fully disclosed", async () => {
    const session = newSessionFixture({mask: []});
    const {store} = makeStore(session);
    const result = await resolveAndConsumeExport(store, session.token, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.disclosed).toEqual(FIXTURE.leaves);
    expect(result.data.obfuscatedLeafHashes).toEqual([]);
  });

  it("an INCONSISTENT partial-custody artifact (root does not account for its own inherited hash) is refused by the self-check, not silently served", async () => {
    // FIXTURE.root was computed over exactly [3 reserved + 2 disclosed leaves] - folding in an
    // extra "inherited" obfuscated hash without that root ALSO accounting for it is exactly the
    // corrupted-data shape the self-check exists to catch. See the next test for the properly
    // consistent version (root recomputed to include the inherited hash) succeeding.
    const inheritedHash = `0x${"ee".repeat(32)}`;
    const session = newSessionFixture();
    const {store} = makeStore(session, {artifact: newArtifactFixture({obfuscatedLeafHashes: [inheritedHash]})});
    const result = await resolveAndConsumeExport(store, session.token, NOW);
    expect(result).toEqual({ok: false, code: "internal_error"});
  });

  it("a genuinely consistent partial-custody artifact (root DOES account for the inherited hash) re-exports it unioned with a fresh mask", async () => {
    const disclosed = [FIXTURE.leaves[0]!]; // "credentialSubject.name" only
    const preObfuscated = leafHashOf(FIXTURE.leaves[1]!); // "credentialSubject.species" already masked at import time
    const reservedFields = FIXTURE.reservedLeafHashes.map((h) => BigInt(h));
    const disclosedFields = disclosed.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), {tag: l.tag, value: l.value} as TypedScalar));
    const consistentRoot = toHex32(buildMerkle([...reservedFields, BigInt(preObfuscated), ...disclosedFields]).root);

    const session = newSessionFixture({root: consistentRoot}); // no additional mask this time
    const {store} = makeStore(session, {
      artifact: newArtifactFixture({root: consistentRoot, leaves: disclosed, obfuscatedLeafHashes: [preObfuscated]}),
    });

    const result = await resolveAndConsumeExport(store, session.token, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.disclosed).toEqual(disclosed);
    expect(result.data.obfuscatedLeafHashes).toEqual([preObfuscated]);
  });

  it("internal_error (never served) when the artifact's stored data does not actually recompute its own root - the self-check safety net", async () => {
    const session = newSessionFixture(); // root: FIXTURE.root - the LOOKUP must still succeed
    // Root stays FIXTURE.root (so findArtifactByPetAndRoot's lookup succeeds and this is NOT a
    // "superseded" case) but a leaf's value is tampered - createTagArtifact itself would never
    // persist this combination, but the self-check exists precisely so a bug or corruption
    // elsewhere can never result in serving an unverifiable payload.
    const tamperedLeaves = FIXTURE.leaves.map((l) => (l.keyPath === "credentialSubject.name" ? {...l, value: "Someone Else"} : l));
    const {store, sessions} = makeStore(session, {artifact: newArtifactFixture({leaves: tamperedLeaves})});
    const result = await resolveAndConsumeExport(store, session.token, NOW);
    expect(result).toEqual({ok: false, code: "internal_error"});
    // Still one-shot: the token is already burned by the time the self-check runs (step 2 predates
    // it), matching every other refusal's semantics - no retry endpoint exists for this code either.
    expect(sessions.get(session.token)?.usedAt).toBe(NOW);
  });
});
