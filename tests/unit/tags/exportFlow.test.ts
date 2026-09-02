import {describe, expect, it} from "vitest";
import {resolveAndConsumeExport, type ExportedArtifactRow, type ExportFlowStore, type ExportSessionRow} from "@/lib/tags/exportFlow";

const NOW = 1_735_689_600;

function newSessionFixture(overrides?: Partial<ExportSessionRow>): ExportSessionRow {
  return {
    token: "a".repeat(32),
    petId: "pet-1",
    root: `0x${"ab".repeat(32)}`,
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
    root: `0x${"ab".repeat(32)}`,
    leaves: [{keyPath: "credentialSubject.name", saltHex: "0x00", tag: 1, value: "Rex"}],
    reservedLeafHashes: [`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`, `0x${"3".repeat(64)}`],
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
  it("happy path: returns the active artifact's full payload and burns the token", async () => {
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
        root: `0x${"ab".repeat(32)}`,
        leaves: [{keyPath: "credentialSubject.name", saltHex: "0x00", tag: 1, value: "Rex"}],
        reservedLeafHashes: [`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`, `0x${"3".repeat(64)}`],
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
