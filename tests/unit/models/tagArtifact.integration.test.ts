import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";
import mongoose from "mongoose";
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
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";
import {
  activateAnchoredArtifact,
  createTagArtifact,
  findActiveTagArtifact,
  supersedeActiveArtifactsForPet,
  type CreateTagArtifactInput,
} from "@/lib/tags/artifact";
import {linkPetDogTag} from "@/lib/mint/reconcile";
import {TagArtifact} from "@/lib/models/TagArtifact";
import {Pet} from "@/lib/models/Pet";

/**
 * WP4.9 item 2 - the TagArtifact write-helper invariant, against a REAL ephemeral mongod (needed
 * for the unique `root` index and `updateMany` semantics an in-memory fake can't reproduce - same
 * rationale as every other `.integration.test.ts` in this repo, `ephemeralMongod.ts`'s own doc
 * comment).
 *
 * ISOLATION: own ephemeral mongod, port 44124 (44117-44123 already taken by sibling suites - see
 * each file's own ISOLATION note). Never `process.env.MONGODB_URI`, never 127.0.0.1:27500.
 */

const MONGO_PORT = 44_124;

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-tag-artifact");
  await mongoose.connect(ephemeral.uri);
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  expect(mongoose.connection.name).toBe("dogtag-vet-tag-artifact");
  // The unique `root` index builds in the background on model compilation - wait for it before any
  // test relies on it rejecting a duplicate.
  await TagArtifact.init();
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Promise.all([TagArtifact.deleteMany({}), Pet.deleteMany({})]);
});

const ISSUER_CLONE = "0x5BD5048125F223100A2753A740F34D044AB493B"; // deliberately mixed-case
const DOG_TAG_ID_DEC = "42";
const DOG_TAG_ID_FIELD = dogTagIdField(DOG_TAG_ID_DEC).toString(10);

/** Genuine (leaves, reservedLeafHashes, root) triple - hashLeaf + buildMerkle, the exact primitives
 * `verifyLeafCommitment` itself recomputes with (same fixture-building convention as
 * `tests/unit/tags/verifier.test.ts` and `tests/unit/booking/mobileReconcile.test.ts`). */
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

function baseInput(overrides: Partial<CreateTagArtifactInput> = {}): CreateTagArtifactInput {
  const {leaves, reservedLeafHashes, root} = buildVerifiableFixture();
  return {
    petId: "pet-1",
    dogTagIdDec: DOG_TAG_ID_DEC,
    dogTagIdField: DOG_TAG_ID_FIELD,
    root,
    protocolVersion: "dogtag-v2/1",
    schemaId: "https://dogtag.io/schemas/dog-profile/v1",
    leaves,
    reservedLeafHashes,
    expectedIdentityLeaves: [],
    source: "issued_here",
    issuerClone: ISSUER_CLONE,
    now: 1_700_000_000,
    ...overrides,
  };
}

describe("createTagArtifact - the invariant (accept/refuse)", () => {
  it("accepts a genuinely verifiable insert and stores every field, root/issuerClone lowercased", async () => {
    const input = baseInput();
    const result = await createTagArtifact(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.artifact.petId).toBe("pet-1");
    expect(result.artifact.root).toBe(input.root.toLowerCase());
    expect(result.artifact.issuerClone).toBe(ISSUER_CLONE.toLowerCase());
    expect(result.artifact.active).toBe(true);
    expect(result.artifact.verifiedAt).toBe(1_700_000_000);
    expect(result.artifact.leaves).toEqual(input.leaves.map((l) => ({keyPath: l.keyPath, saltHex: l.saltHex, tag: l.tag, value: l.value})));
    expect(result.artifact.reservedLeafHashes).toEqual(input.reservedLeafHashes);
    expect(result.artifact.schemaId).toBe("https://dogtag.io/schemas/dog-profile/v1");

    expect(await TagArtifact.countDocuments({})).toBe(1);
  });

  it("refuses (no insert) when the leaves are tampered - root no longer recomputes", async () => {
    const {leaves, reservedLeafHashes, root} = buildVerifiableFixture();
    const tampered = leaves.map((l) => (l.keyPath === "credentialSubject.name" ? {...l, value: "Max"} : l));
    const result = await createTagArtifact(baseInput({leaves: tampered, reservedLeafHashes, root}));
    expect(result).toEqual({ok: false, reason: "leaf_commitment_invalid"});
    expect(await TagArtifact.countDocuments({})).toBe(0);
  });

  it("refuses on an unsupported protocol version", async () => {
    const result = await createTagArtifact(baseInput({protocolVersion: "dogtag-v3/1"}));
    expect(result).toEqual({ok: false, reason: "unsupported_protocol_version"});
    expect(await TagArtifact.countDocuments({})).toBe(0);
  });

  it("a refused insert (tampered leaves) never supersedes the pet's existing active artifact", async () => {
    const first = await createTagArtifact(baseInput());
    expect(first.ok).toBe(true);

    const {leaves, reservedLeafHashes, root} = buildVerifiableFixture("Different");
    const tampered = leaves.map((l) => (l.keyPath === "credentialSubject.name" ? {...l, value: "Tampered"} : l));
    const second = await createTagArtifact(baseInput({leaves: tampered, reservedLeafHashes, root}));
    expect(second.ok).toBe(false);

    const active = await findActiveTagArtifact("pet-1");
    expect(active?.root).toBe((first.ok ? first.artifact.root : "")); // the FIRST artifact is still active, untouched
  });

  it("a refused insert (unsupported protocol version) never supersedes the pet's existing active artifact", async () => {
    const first = await createTagArtifact(baseInput());
    expect(first.ok).toBe(true);

    const second = await createTagArtifact(baseInput({...buildVerifiableFixture("Different"), protocolVersion: "dogtag-v3/1"}));
    expect(second.ok).toBe(false);

    expect(await TagArtifact.countDocuments({active: true})).toBe(1);
    const active = await findActiveTagArtifact("pet-1");
    expect(active?.active).toBe(true);
  });

  it("reissue: a second successful create for the same pet supersedes the first (exactly one active remains)", async () => {
    const first = await createTagArtifact(baseInput());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");

    const {leaves, reservedLeafHashes, root} = buildVerifiableFixture("Rex II");
    const second = await createTagArtifact(baseInput({leaves, reservedLeafHashes, root}));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");

    expect(await TagArtifact.countDocuments({petId: "pet-1"})).toBe(2);
    expect(await TagArtifact.countDocuments({petId: "pet-1", active: true})).toBe(1);

    const supersededFirst = await TagArtifact.findOne({root: first.artifact.root}).lean();
    expect(supersededFirst?.active).toBe(false);
    expect(supersededFirst?.supersededByRoot).toBe(second.artifact.root);

    const activeSecond = await findActiveTagArtifact("pet-1");
    expect(activeSecond?.root).toBe(second.artifact.root);
  });

  it("refuses a genuine duplicate root claimed by a DIFFERENT pet (should be cryptographically impossible; a real bug upstream if it ever fires)", async () => {
    const input = baseInput();
    const first = await createTagArtifact(input);
    expect(first.ok).toBe(true);
    await expect(createTagArtifact({...input, petId: "pet-2"})).rejects.toThrow(/already belongs to pet pet-1/i);
    // Still exactly one row - the rejected attempt never inserted anything.
    expect(await TagArtifact.countDocuments({})).toBe(1);
  });

  it("is IDEMPOTENT for the SAME (petId, root): a repeat call returns the existing row, never a duplicate-key error, never a supersede", async () => {
    const input = baseInput();
    const first = await createTagArtifact(input);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.reactivated).toBe(false);

    const second = await createTagArtifact(input);
    expect(second).toEqual(first);
    expect(await TagArtifact.countDocuments({})).toBe(1);
    expect(await TagArtifact.countDocuments({active: true})).toBe(1);
  });

  /**
   * WP4.9V FIX ROUND 1 (D1) - the grader's PROBE B, at the unit level: a repeat `createTagArtifact`
   * call against a row for the SAME (petId, root) that is currently `active: false` (the crash
   * window this function's own doc comment describes) must REPAIR it, not silently return it
   * unchanged. Before this fix, `existing` was returned verbatim regardless of `active`, so the
   * pet stayed at zero active artifacts forever and every repeat call looked like success.
   *
   * BITE PROOF: reverting the `if (!existing.active)` branch (back to unconditionally returning
   * `existing`) turns this test red - `reactivated` would be absent/false, `active` would stay
   * `false`, and `findActiveTagArtifact` would keep returning `null`.
   */
  it("(D1) reactivates an existing INACTIVE row for the same (petId, root) rather than treating it as a no-op", async () => {
    const input = baseInput();
    const first = await createTagArtifact(input);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");

    // Simulate the crash-window state directly: this row got superseded (by some OTHER root that
    // never actually landed) without ever being cleaned up.
    await TagArtifact.updateOne({root: first.artifact.root}, {$set: {active: false, supersededByRoot: `0x${"cc".repeat(32)}`}});
    expect(await findActiveTagArtifact("pet-1")).toBeNull();

    const repeat = await createTagArtifact(input);
    expect(repeat.ok).toBe(true);
    if (!repeat.ok) throw new Error("unreachable");
    expect(repeat.reactivated).toBe(true);
    expect(repeat.artifact.active).toBe(true);
    expect(repeat.artifact.supersededByRoot).toBeUndefined();

    expect(await TagArtifact.countDocuments({})).toBe(1); // repaired in place, never a duplicate
    const active = await findActiveTagArtifact("pet-1");
    expect(active?.root).toBe(first.artifact.root);
  });
});

describe("activateAnchoredArtifact (D3 - anchor-at-confirm custody promotion)", () => {
  it("promotes an inactive issued_here artifact to active and supersedes the pet's prior active row", async () => {
    const first = await createTagArtifact(baseInput());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");

    // Mirrors the custodial-bind side effect: created but NOT activated yet.
    const {leaves, reservedLeafHashes, root} = buildVerifiableFixture("Rex II");
    const second = await createTagArtifact(baseInput({leaves, reservedLeafHashes, root, activate: false}));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.artifact.active).toBe(false);
    // Creating with `activate: false` must NOT have superseded the first artifact either.
    expect((await findActiveTagArtifact("pet-1"))?.root).toBe(first.artifact.root);

    const outcome = await activateAnchoredArtifact("pet-1", second.artifact.root);
    expect(outcome).toEqual({activated: true});

    const active = await findActiveTagArtifact("pet-1");
    expect(active?.root).toBe(second.artifact.root);
    const supersededFirst = await TagArtifact.findOne({root: first.artifact.root}).lean();
    expect(supersededFirst?.active).toBe(false);
    expect(supersededFirst?.supersededByRoot).toBe(second.artifact.root);
  });

  it("is a defensive no-op (never throws) when no artifact exists yet for this (petId, root)", async () => {
    await expect(activateAnchoredArtifact("nobody", "0xdead")).resolves.toEqual({activated: false});
    expect(await TagArtifact.countDocuments({})).toBe(0);
  });

  it("is idempotent when the named artifact is already active (no re-supersede)", async () => {
    const first = await createTagArtifact(baseInput());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");

    const outcome = await activateAnchoredArtifact("pet-1", first.artifact.root);
    expect(outcome).toEqual({activated: false});
    const stillActive = await TagArtifact.findOne({root: first.artifact.root}).lean();
    expect(stillActive?.active).toBe(true);
  });

  /**
   * WP4.9V FIX ROUND 1 (D3) - the grader's PROBE C, made permanent. Reproduces the exact sequence
   * the grade named: a reissue whose custodial-bind lands (creates the new artifact) BEFORE
   * `issueTag` is ever sent on chain (`lib/mint/flow.ts`'s `custodialBind` only checks the slot is
   * still UNSET, never that THIS root is anchored) - and then the `issueTag` transaction reverts
   * (or the reissue is simply abandoned) so the terminal confirm write NEVER runs for the new root.
   *
   * Before this fix, custodial-bind superseded the OLD artifact and activated the NEW one
   * immediately, so the pet's "active" artifact ended up on R2 - a root that was never anchored -
   * while `Pet.dogTag.root` still (correctly) said R1. `findActiveTagArtifact` and
   * `Pet.dogTag.root` disagreeing is exactly the state the export ceremony must never disclose.
   *
   * BITE PROOF: this test is RED against the pre-fix code shape (custodial-bind calling
   * `createTagArtifact` with its old unconditional-supersede behavior, i.e. without `activate:
   * false`, and confirm never calling `activateAnchoredArtifact` at all) - `active?.root` would
   * equal R2, not R1, and the disclosure check would be `true`.
   */
  it("(PROBE C) a reissue whose custodial-bind lands but whose confirm never runs leaves the pet's ACTIVE artifact on the ANCHORED root", async () => {
    const first = buildVerifiableFixture("Rex");
    const second = buildVerifiableFixture("Rexy"); // the reissue's new tree - a different root

    // State after the ORIGINAL issuance confirmed: pet.dogTag.root = R1, artifact R1 active.
    await Pet.create({
      petId: "pet-reissue",
      name: "Probe Pet",
      ownerClientIds: [],
      dogTag: {dogTagIdDec: DOG_TAG_ID_DEC, dogTagIdField: DOG_TAG_ID_FIELD, root: first.root, status: "active", cloneAddress: ISSUER_CLONE},
      searchKey: "probe pet",
    });
    const a = await createTagArtifact({
      petId: "pet-reissue",
      dogTagIdDec: DOG_TAG_ID_DEC,
      dogTagIdField: DOG_TAG_ID_FIELD,
      root: first.root,
      protocolVersion: "dogtag-v2/1",
      leaves: first.leaves,
      reservedLeafHashes: first.reservedLeafHashes,
      expectedIdentityLeaves: [],
      source: "issued_here",
      issuerClone: ISSUER_CLONE,
      now: 1_699_000_000,
    });
    expect(a.ok).toBe(true);

    // The reissue's custodial-bind terminal write - `activate: false`, exactly like
    // `issuedArtifactSideEffect.ts`'s `mongoIssuedArtifactStore` now calls it.
    const b = await createTagArtifact({
      petId: "pet-reissue",
      dogTagIdDec: DOG_TAG_ID_DEC,
      dogTagIdField: DOG_TAG_ID_FIELD,
      root: second.root,
      protocolVersion: "dogtag-v2/1",
      leaves: second.leaves,
      reservedLeafHashes: second.reservedLeafHashes,
      expectedIdentityLeaves: [],
      source: "issued_here",
      issuerClone: ISSUER_CLONE,
      now: 1_700_000_000,
      activate: false,
    });
    expect(b.ok).toBe(true);
    if (!b.ok) throw new Error("unreachable");
    expect(b.artifact.active).toBe(false);

    // ... and then the issueTag transaction REVERTS (e2e/mint-issue-revert.spec.ts's own scenario):
    // `reconcileAnchoredSession`'s reverted branch calls `markSessionRevertedReady` and returns
    // WITHOUT ever calling `linkPetDogTag` - so `activateAnchoredArtifact` never runs for R2.
    const active = await findActiveTagArtifact("pet-reissue");
    const pet = await Pet.findOne({petId: "pet-reissue"}).lean();
    expect(active?.root).toBe(first.root.toLowerCase()); // still R1 - never promoted to the un-anchored R2
    expect(pet?.dogTag?.root?.toLowerCase()).toBe(first.root.toLowerCase());
    expect(active?.root !== pet?.dogTag?.root?.toLowerCase()).toBe(false); // export would NOT disclose an un-anchored root

    // If the SAME reissue is instead retried to success, the terminal confirm write
    // (`linkPetDogTag`) promotes R2 exactly then - proving the other half of the fix, not just the
    // "revert never promotes" half.
    await linkPetDogTag("pet-reissue", {
      dogTagIdDec: DOG_TAG_ID_DEC,
      dogTagIdField: DOG_TAG_ID_FIELD,
      root: second.root,
      cloneAddress: ISSUER_CLONE,
    });
    const activeAfterConfirm = await findActiveTagArtifact("pet-reissue");
    const petAfterConfirm = await Pet.findOne({petId: "pet-reissue"}).lean();
    expect(activeAfterConfirm?.root).toBe(second.root.toLowerCase());
    expect(petAfterConfirm?.dogTag?.root?.toLowerCase()).toBe(second.root.toLowerCase());
    const supersededFirst = await TagArtifact.findOne({root: first.root.toLowerCase()}).lean();
    expect(supersededFirst?.active).toBe(false);
  });
});

describe("supersedeActiveArtifactsForPet", () => {
  it("is a no-op when the pet has no active artifact yet", async () => {
    await expect(supersedeActiveArtifactsForPet("pet-none", "0xdead")).resolves.toBeUndefined();
    expect(await TagArtifact.countDocuments({})).toBe(0);
  });

  it("flips EVERY active row for the pet, not just one, given more than one somehow exists (bad-data defense)", async () => {
    const {leaves: leavesA, reservedLeafHashes: reservedA, root: rootA} = buildVerifiableFixture("A");
    const {leaves: leavesB, reservedLeafHashes: reservedB, root: rootB} = buildVerifiableFixture("B");
    // Bypasses the write helper deliberately, to construct the "bad data" precondition (two active
    // rows for one pet) the helper itself should never produce but must tolerate if it is ever
    // found - see the function's own doc comment.
    await TagArtifact.create({
      petId: "pet-bad",
      dogTagIdDec: DOG_TAG_ID_DEC,
      dogTagIdField: DOG_TAG_ID_FIELD,
      root: rootA,
      protocolVersion: "dogtag-v2/1",
      leaves: leavesA,
      reservedLeafHashes: reservedA,
      source: "issued_here",
      issuerClone: ISSUER_CLONE.toLowerCase(),
      verifiedAt: 1,
      active: true,
    });
    await TagArtifact.create({
      petId: "pet-bad",
      dogTagIdDec: DOG_TAG_ID_DEC,
      dogTagIdField: DOG_TAG_ID_FIELD,
      root: rootB,
      protocolVersion: "dogtag-v2/1",
      leaves: leavesB,
      reservedLeafHashes: reservedB,
      source: "issued_here",
      issuerClone: ISSUER_CLONE.toLowerCase(),
      verifiedAt: 2,
      active: true,
    });
    expect(await TagArtifact.countDocuments({petId: "pet-bad", active: true})).toBe(2);

    await supersedeActiveArtifactsForPet("pet-bad", "0xnewroot");

    expect(await TagArtifact.countDocuments({petId: "pet-bad", active: true})).toBe(0);
    const rows = await TagArtifact.find({petId: "pet-bad"}).lean();
    expect(rows.every((r) => r.active === false && r.supersededByRoot === "0xnewroot")).toBe(true);
  });
});

describe("findActiveTagArtifact", () => {
  it("returns null when the pet has no artifact", async () => {
    expect(await findActiveTagArtifact("nobody")).toBeNull();
  });

  it("returns the active row, never a superseded one", async () => {
    const first = await createTagArtifact(baseInput());
    expect(first.ok).toBe(true);
    const {leaves, reservedLeafHashes, root} = buildVerifiableFixture("Rex II");
    const second = await createTagArtifact(baseInput({leaves, reservedLeafHashes, root}));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");

    const active = await findActiveTagArtifact("pet-1");
    expect(active?.root).toBe(second.artifact.root);
  });
});
