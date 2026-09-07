// Unit coverage for redactedArtifact.ts - WP4.10S item 2. Two halves:
//
//  1. An EQUIVALENCE proof: `verifyRedactedArtifact` is a strict generalization of
//     `verifyLeafCommitment` (profile_bind.test.ts's own primitive) - on every one of that file's
//     fixtures, translated into a `RedactedTagArtifact` with `obfuscatedLeafHashes: []`, the two
//     functions agree, accept and reject alike. The fixture-building helpers below are a deliberate
//     duplication of profile_bind.test.ts's own (private, test-file-local) helpers, not an import -
//     this is what lets both test files build the identical scenario independently and still agree.
//  2. Masking-specific behavior no `verifyLeafCommitment` fixture exercises: a real masked artifact,
//     the empty-non-maskable-set finding (WP4.10S item 1), overlap, and the reserved-triple-relabeled
//     -as-obfuscated bite proof (the concrete non-maskable-shaped invariant this artifact type
//     actually has - see redactedArtifact.ts's file header and the progress log for the full case).
import {describe, it, expect} from "vitest";
import {TypeTag, hashLeaf, buildMerkle, toHex32, hexToBytes, type TypedScalar} from "../src/index.js";
import {verifyLeafCommitment, type OpenedLeaf, type VerifyLeafCommitmentInput} from "../src/profileBind.js";
import {verifyRedactedArtifact, type RedactedTagArtifact} from "../src/redactedArtifact.js";

function salt(n: number): Uint8Array {
  return new Uint8Array(16).fill(n);
}

function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function opened(keyPath: string, saltByte: number, tag: TypeTag, value: string): OpenedLeaf {
  return {keyPath, saltHex: bytesToHex(salt(saltByte)), tag, value};
}

/** The 3 reserved owner-control leaves, as opaque hashes - identical construction to
 * profile_bind.test.ts's own `reservedHashes()` (just distinct field elements for a test; an
 * outside verifier never recomputes these for real, see redactedArtifact.ts's file header). */
function reservedHashes(): string[] {
  return [
    hashLeaf("owner.address", salt(201), {tag: TypeTag.Bytes, value: new Uint8Array([1])} as TypedScalar),
    hashLeaf("owner.consentKey", salt(202), {tag: TypeTag.Bytes, value: new Uint8Array([2])} as TypedScalar),
    hashLeaf("owner.secret", salt(203), {tag: TypeTag.Bytes, value: new Uint8Array([3])} as TypedScalar),
  ].map(toHex32);
}

function identityOpenings(): OpenedLeaf[] {
  return [
    opened("owner.identity.fullName", 21, TypeTag.String, "Alice Owner"),
    opened("owner.identity.country", 22, TypeTag.String, "GB"),
    opened("owner.identity.docNumber", 23, TypeTag.String, "PASSPORT-123"),
  ];
}

function petOpenings(): OpenedLeaf[] {
  return [
    opened("credentialSubject.name", 7, TypeTag.String, "Rex"),
    opened("credentialSubject.breedLabel", 9, TypeTag.String, "Shiba Inu"),
  ];
}

function scalarOf(l: OpenedLeaf): TypedScalar {
  switch (l.tag) {
    case TypeTag.Null:
      return {tag: TypeTag.Null, value: null};
    case TypeTag.Bool:
      return {tag: TypeTag.Bool, value: l.value === "true"};
    case TypeTag.Bytes:
      // hexToBytes(l.value), not an unconditional empty array: this only ever mattered once a
      // Bytes-tagged leaf was built via opened()/computeRoot() below (every prior use of TypeTag.Bytes
      // in this file goes straight through hashLeaf() in reservedHashes(), bypassing this function
      // entirely) - fixed so a real Bytes value round-trips instead of being silently discarded.
      return {tag: TypeTag.Bytes, value: hexToBytes(l.value)};
    default:
      return {tag: l.tag, value: l.value} as TypedScalar;
  }
}

/** Build the real root from a set of openings + reserved hashes - identical to
 * profile_bind.test.ts's own `computeRoot`. */
function computeRoot(reserved: string[], leaves: OpenedLeaf[]): string {
  const reservedFields = reserved.map((h) => BigInt(h));
  const leafFields = leaves.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalarOf(l)));
  return toHex32(buildMerkle([...reservedFields, ...leafFields]).root);
}

/** The envelope fields `verifyRedactedArtifact`'s pure crypto check never inspects (plan step 5 is a
 * caller's on-chain job) - fixed placeholders so every test artifact below is well-typed. */
const ENVELOPE = {protocolVersion: "dogtag-v2/1", dogTagIdField: "1", issuerClone: "0x" + "11".repeat(20)};

/** Translate a `VerifyLeafCommitmentInput` into the DEGENERATE (nothing obfuscated)
 * `RedactedTagArtifact` the plan calls out: `disclosed` holds every opened leaf, exactly as
 * `verifyLeafCommitment` would see them. */
function toArtifact(input: VerifyLeafCommitmentInput): RedactedTagArtifact {
  return {
    ...ENVELOPE,
    root: input.root,
    disclosed: input.leaves,
    obfuscatedLeafHashes: [],
    reservedLeafHashes: input.reservedLeafHashes,
  };
}

interface Scenario {
  name: string;
  input: VerifyLeafCommitmentInput;
  expected: boolean;
}

// Every profile_bind.test.ts case, rebuilt from scratch here (see the file header for why this is a
// deliberate second transcription rather than a shared import).
const scenarios: Scenario[] = (() => {
  const reserved = reservedHashes();
  const petAndIdentity = [...petOpenings(), ...identityOpenings()];
  const rootPetAndIdentity = computeRoot(reserved, petAndIdentity);
  const petOnly = petOpenings();
  const rootPetOnly = computeRoot(reserved, petOnly);

  const alteredName = petAndIdentity.map((l) => (l.keyPath === "credentialSubject.name" ? {...l, value: "Fido"} : l));

  const droppedDocNumber = petAndIdentity.filter((l) => l.keyPath !== "owner.identity.docNumber");
  const rootDropped = computeRoot(reserved, droppedDocNumber);

  const injected = [...petAndIdentity, opened("owner.identity.extra", 24, TypeTag.String, "sneaky")];
  const rootInjected = computeRoot(reserved, injected);

  const dup = [...petAndIdentity, opened("owner.identity.country", 22, TypeTag.String, "GB")];
  const rootDup = computeRoot(reserved, dup);

  const expectedWithDuplicate = [...identityOpenings(), opened("owner.identity.country", 22, TypeTag.String, "GB")];

  const many61: OpenedLeaf[] = Array.from({length: 61}, (_, i) => opened(`credentialSubject.extra[${i}]`, (i % 250) + 1, TypeTag.String, `v${i}`));
  const rootMany61 = computeRoot(reserved, many61);
  const many62: OpenedLeaf[] = [...many61, opened("credentialSubject.extra[61]", 99, TypeTag.String, "v61")];

  const sneakyReserved = [...petOnly, opened("owner.secret", 5, TypeTag.String, "x")];
  const rootSneaky = computeRoot(reserved, sneakyReserved);

  return [
    {
      name: "accepts a genuine tree: 3 reserved + pet + identity openings, identity matches expected",
      input: {root: rootPetAndIdentity, leaves: petAndIdentity, reservedLeafHashes: reserved, expectedIdentityLeaves: identityOpenings()},
      expected: true,
    },
    {
      name: "accepts a tree with no identity leaves when none are expected",
      input: {root: rootPetOnly, leaves: petOnly, reservedLeafHashes: reserved, expectedIdentityLeaves: []},
      expected: true,
    },
    {
      name: "rejects an altered value (root no longer matches)",
      input: {root: rootPetAndIdentity, leaves: alteredName, reservedLeafHashes: reserved, expectedIdentityLeaves: identityOpenings()},
      expected: false,
    },
    {
      name: "rejects a dropped identity leaf (posted set no longer matches expected)",
      input: {root: rootDropped, leaves: droppedDocNumber, reservedLeafHashes: reserved, expectedIdentityLeaves: identityOpenings()},
      expected: false,
    },
    {
      name: "rejects an injected extra identity leaf not in the expected set",
      input: {root: rootInjected, leaves: injected, reservedLeafHashes: reserved, expectedIdentityLeaves: identityOpenings()},
      expected: false,
    },
    {
      name: "rejects a posted leaf that duplicates an existing keyPath",
      input: {root: rootDup, leaves: dup, reservedLeafHashes: reserved, expectedIdentityLeaves: identityOpenings()},
      expected: false,
    },
    {
      name: "rejects when the EXPECTED identity set itself has a duplicate (multiset, not set-membership)",
      input: {root: rootPetAndIdentity, leaves: petAndIdentity, reservedLeafHashes: reserved, expectedIdentityLeaves: expectedWithDuplicate},
      expected: false,
    },
    {
      name: "rejects a wrong root",
      input: {root: toHex32(999999n), leaves: petAndIdentity, reservedLeafHashes: reserved, expectedIdentityLeaves: identityOpenings()},
      expected: false,
    },
    {
      name: "rejects 2 reserved hashes",
      input: {root: toHex32(1n), leaves: petOnly, reservedLeafHashes: reserved.slice(0, 2), expectedIdentityLeaves: []},
      expected: false,
    },
    {
      name: "rejects 4 reserved hashes",
      input: {root: toHex32(1n), leaves: petOnly, reservedLeafHashes: [...reserved, toHex32(42n)], expectedIdentityLeaves: []},
      expected: false,
    },
    {
      name: "rejects more than 64 total leaves (3 reserved + 62 opened)",
      input: {root: rootMany61, leaves: many62, reservedLeafHashes: reserved, expectedIdentityLeaves: []},
      expected: false,
    },
    {
      name: "accepts exactly at the 64-leaf cap (3 reserved + 61 opened)",
      input: {root: rootMany61, leaves: many61, reservedLeafHashes: reserved, expectedIdentityLeaves: []},
      expected: true,
    },
    {
      name: "rejects an opened leaf that names a reserved owner-control keyPath",
      input: {root: rootSneaky, leaves: sneakyReserved, reservedLeafHashes: reserved, expectedIdentityLeaves: []},
      expected: false,
    },
    {
      name: "rejects a malformed opening (bad salt hex) fail-closed rather than throwing",
      input: {
        root: toHex32(1n),
        leaves: [{keyPath: "credentialSubject.name", saltHex: "0xzz", tag: TypeTag.String, value: "Rex"}],
        reservedLeafHashes: reserved,
        expectedIdentityLeaves: [],
      },
      expected: false,
    },
  ];
})();

describe("verifyRedactedArtifact generalizes verifyLeafCommitment - equivalence on every existing fixture", () => {
  it(`covers every profile_bind.test.ts accept/reject case (${scenarios.length} scenarios, both true and false present)`, () => {
    const outcomes = new Set(scenarios.map((s) => s.expected));
    expect(outcomes.has(true)).toBe(true);
    expect(outcomes.has(false)).toBe(true);
    expect(scenarios.length).toBe(14);
  });

  for (const s of scenarios) {
    it(s.name, () => {
      const legacyResult = verifyLeafCommitment(s.input);
      expect(legacyResult, "scenario's own expected outcome").toBe(s.expected);

      const artifact = toArtifact(s.input);
      const generalizedResult = verifyRedactedArtifact(artifact, {expectedIdentityLeaves: s.input.expectedIdentityLeaves});
      expect(
        generalizedResult,
        `verifyRedactedArtifact(x, {obfuscated: [], identity}) must equal verifyLeafCommitment(x) for "${s.name}"`,
      ).toBe(legacyResult);
    });
  }

  it("also agrees when the identity oracle is entirely omitted (the generalization opts's optionality) on the no-identity-expected case", () => {
    const reserved = reservedHashes();
    const leaves = petOpenings();
    const root = computeRoot(reserved, leaves);
    const legacy = verifyLeafCommitment({root, leaves, reservedLeafHashes: reserved, expectedIdentityLeaves: []});
    const generalized = verifyRedactedArtifact(toArtifact({root, leaves, reservedLeafHashes: reserved, expectedIdentityLeaves: []}));
    expect(generalized).toBe(legacy);
    expect(generalized).toBe(true);
  });
});

describe("verifyRedactedArtifact - masking-specific behavior", () => {
  // A 3-attribute profile (name/species/microchip.code), matching the exact keyPaths and salts
  // specs/leaf-commitment-vectors.json's merkleVectors[0] uses, for cross-file continuity.
  function name(): OpenedLeaf {
    return opened("credentialSubject.name", 0xaa, TypeTag.String, "Rex");
  }
  function species(): OpenedLeaf {
    return opened("credentialSubject.species", 0xbb, TypeTag.String, "dog");
  }
  function microchip(): OpenedLeaf {
    return opened("credentialSubject.microchip.code", 0xcc, TypeTag.String, "985141006580319");
  }
  function hashOf(l: OpenedLeaf): string {
    return toHex32(hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalarOf(l)));
  }

  it("accepts the degenerate full artifact (nothing obfuscated)", () => {
    const reserved = reservedHashes();
    const disclosed = [name(), species(), microchip()];
    const root = computeRoot(reserved, disclosed);
    const artifact: RedactedTagArtifact = {...ENVELOPE, root, disclosed, obfuscatedLeafHashes: [], reservedLeafHashes: reserved};
    expect(verifyRedactedArtifact(artifact)).toBe(true);
  });

  it("accepts a genuinely masked artifact: species obfuscated, root UNCHANGED from the full artifact", () => {
    const reserved = reservedHashes();
    const full = [name(), species(), microchip()];
    const root = computeRoot(reserved, full);

    const masked: RedactedTagArtifact = {
      ...ENVELOPE,
      root,
      disclosed: [name(), microchip()],
      obfuscatedLeafHashes: [hashOf(species())],
      reservedLeafHashes: reserved,
    };
    expect(verifyRedactedArtifact(masked)).toBe(true);
  });

  it("accepts a FULLY obfuscated artifact (disclosed: [], every attribute masked) - pins the empty non-maskable-set finding", () => {
    // WP4.10S item 1: this artifact type has NO non-maskable attribute keyPath (see
    // redactedArtifact.ts's file header + the progress log for the evidence trail). This is the
    // FALSIFIABLE form of that claim: it must go RED the instant a future revision adds a real
    // "must stay disclosed" requirement without updating this decision.
    const reserved = reservedHashes();
    const full = [name(), species(), microchip()];
    const root = computeRoot(reserved, full);

    const artifact: RedactedTagArtifact = {
      ...ENVELOPE,
      root,
      disclosed: [],
      obfuscatedLeafHashes: [hashOf(name()), hashOf(species()), hashOf(microchip())],
      reservedLeafHashes: reserved,
    };
    expect(verifyRedactedArtifact(artifact)).toBe(true);
  });

  it("rejects overlap: a leaf claimed as BOTH disclosed and separately obfuscated", () => {
    const reserved = reservedHashes();
    const full = [name(), species(), microchip()];
    const root = computeRoot(reserved, full);

    const artifact: RedactedTagArtifact = {
      ...ENVELOPE,
      root,
      disclosed: [name(), species(), microchip()], // species fully disclosed...
      obfuscatedLeafHashes: [hashOf(species())], // ...AND separately claimed as obfuscated
      reservedLeafHashes: reserved,
    };
    expect(verifyRedactedArtifact(artifact)).toBe(false);
  });

  // D4 bite proof (grade round 1): the overlap test above builds `root` over 6 leaves (3 reserved +
  // 3 attributes) but then POSTS 7 hashes (3 reserved + 3 disclosed + 1 obfuscated) - the ROOT CHECK
  // alone already rejects that shape mismatch, so deleting the overlap check entirely leaves this
  // suite green. The two tests below are constructed so the posted root is the GENUINE root of the
  // EXACT multiset verifyRedactedArtifact folds - the only thing that can still reject them is the
  // overlap check itself, isolating first its OBFUSCATED half, then its RESERVED half.
  // hashOf() above returns a HEX STRING (wire shape) - buildMerkle needs the underlying Field
  // (bigint), so the bite-proof tests below recompute it directly via hashLeaf, exactly like the
  // reserved-relabel test above does; only toHex32(...) of THAT bigint goes on the wire.
  function bigHashOf(l: OpenedLeaf): bigint {
    return hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalarOf(l));
  }

  it("rejects a root-preserving overlap built from a genuinely DUPLICATED attribute leaf (obfuscated half): the device tree builder enforces keyPath uniqueness only against the 3 reserved keyPaths, so a real tree may commit to the same attribute leaf hash twice - one copy disclosed, the other separately obfuscated. The root recomputes EXACTLY; only the overlap check (against obfuscatedLeafHashes) can reject this (D2's bite proof)", () => {
    const reserved = reservedHashes();
    const a = species();
    const b = microchip();
    const hashA = bigHashOf(a);
    const hashB = bigHashOf(b);
    // The tree genuinely contains hash(a) TWICE plus hash(b) once - a legitimate duplicate, not a
    // malformed posting: build_profile_tree never checks attribute leaves for cross-keyPath uniqueness.
    const genuineRoot = buildMerkle([...reserved.map((h) => BigInt(h)), hashA, hashA, hashB]).root;
    const artifact: RedactedTagArtifact = {
      ...ENVELOPE,
      root: toHex32(genuineRoot),
      disclosed: [a, b], // one copy of the duplicated leaf, opened...
      obfuscatedLeafHashes: [toHex32(hashA)], // ...the OTHER copy's hash, obfuscated
      reservedLeafHashes: reserved,
    };
    // Bite proof: the exact multiset verifyRedactedArtifact would fold (reserved + obfuscated +
    // recomputed disclosed) recomputes the SAME root as the genuine tree, independently via buildMerkle
    // - so nothing but the overlap check can be rejecting this artifact.
    const independentRoot = buildMerkle([...reserved.map((h) => BigInt(h)), hashA, hashA, hashB]).root;
    expect(toHex32(independentRoot), "the root must recompute EXACTLY for this to isolate the overlap check").toBe(toHex32(genuineRoot));
    expect(verifyRedactedArtifact(artifact)).toBe(false);
  });

  it("rejects a root-preserving overlap on the RESERVED half specifically (a reservedLeafHashes entry equal to a disclosed leaf's recomputed hash) - and the SAME input is ACCEPTED by verifyLeafCommitment, the exact divergence D3 documents (verifyRedactedArtifact is strictly MORE conservative, never more permissive)", () => {
    const a = species();
    const b = microchip();
    const hashA = bigHashOf(a);
    const reserved1 = hashLeaf("owner.consentKey", salt(202), {tag: TypeTag.Bytes, value: new Uint8Array([2])} as TypedScalar);
    const reserved2 = hashLeaf("owner.secret", salt(203), {tag: TypeTag.Bytes, value: new Uint8Array([3])} as TypedScalar);
    // reservedLeafHashes[0] is deliberately set to hash(a) - this tests the VERIFIER's behavior on a
    // given wire input, not whether a genuine device tree could produce it (it cannot without a
    // Poseidon preimage: hash_reserved_leaf's raw-field slot cannot equal hashLeaf's output).
    const reservedHexes = [toHex32(hashA), toHex32(reserved1), toHex32(reserved2)];
    const genuineRoot = buildMerkle([hashA, reserved1, reserved2, hashA, bigHashOf(b)]).root;

    const artifact: RedactedTagArtifact = {
      ...ENVELOPE,
      root: toHex32(genuineRoot),
      disclosed: [a, b],
      obfuscatedLeafHashes: [],
      reservedLeafHashes: reservedHexes,
    };
    expect(verifyRedactedArtifact(artifact), "overlap check (reserved half) must reject").toBe(false);

    // D3: the identical input, read as a legacy verifyLeafCommitment call (nothing obfuscated,
    // reservedLeafHashes posted as-is), is ACCEPTED - verifyLeafCommitment has no overlap check at all.
    const legacyInput: VerifyLeafCommitmentInput = {
      root: toHex32(genuineRoot),
      leaves: [a, b],
      reservedLeafHashes: reservedHexes,
      expectedIdentityLeaves: [],
    };
    expect(verifyLeafCommitment(legacyInput), "verifyLeafCommitment has no overlap check - the divergence is safe-direction only (VRA strictly more conservative)").toBe(true);
  });

  it("rejects a DUPLICATED pet (non-identity) keyPath with NO identity oracle supplied, so the identity multiset check cannot mask it - the duplicate-keyPath guard is the ONLY thing that can reject this, since the root recomputes exactly", () => {
    const reserved = reservedHashes();
    const nameA = opened("credentialSubject.name", 0x10, TypeTag.String, "Rex");
    const nameB = opened("credentialSubject.name", 0x20, TypeTag.String, "Rex"); // same keyPath, DIFFERENT salt -> different hash, both genuinely fold into the root
    const hashA = bigHashOf(nameA);
    const hashB = bigHashOf(nameB);
    expect(hashA, "guards a vacuous construction - the two hashes must actually differ").not.toBe(hashB);
    const genuineRoot = buildMerkle([...reserved.map((h) => BigInt(h)), hashA, hashB]).root;
    const artifact: RedactedTagArtifact = {
      ...ENVELOPE,
      root: toHex32(genuineRoot),
      disclosed: [nameA, nameB],
      obfuscatedLeafHashes: [],
      reservedLeafHashes: reserved,
    };
    // No opts passed at all: the identity cross-check is skipped entirely (and credentialSubject.name
    // is not an owner.identity.* keyPath either way), so it cannot be the thing rejecting this.
    expect(verifyRedactedArtifact(artifact)).toBe(false);
  });

  it("rejects a reserved leaf relabeled as obfuscated, even though the naive leaf multiset (and hence buildMerkle's root) is IDENTICAL either way - the exactly-3-reserved count check is what catches it, nothing else", () => {
    // The genuine artifact: reserved = [r0,r1,r2], obfuscated = [hash(species)].
    const reserved = reservedHashes();
    const disclosed = [name(), microchip()];
    const genuineRoot = computeRoot(reserved, [...disclosed, species()]);
    const genuine: RedactedTagArtifact = {
      ...ENVELOPE,
      root: genuineRoot,
      disclosed,
      obfuscatedLeafHashes: [hashOf(species())],
      reservedLeafHashes: reserved,
    };
    expect(verifyRedactedArtifact(genuine)).toBe(true);

    // The attack: move reserved[2] out of reservedLeafHashes and into obfuscatedLeafHashes instead.
    // The flat set of hashes fed to buildMerkle - {reserved[0], reserved[1], reserved[2],
    // hash(species), hash(name), hash(microchip.code)} - is EXACTLY THE SAME SET either way, so the
    // recomputed root is bit-for-bit identical to the genuine one. Bite proof: prove that first.
    const relabeledReserved = reserved.slice(0, 2);
    const relabeledObfuscated = [hashOf(species()), reserved[2]!];
    const relabeledRoot = toHex32(
      buildMerkle([
        ...relabeledReserved.map((h) => BigInt(h)),
        ...relabeledObfuscated.map((h) => BigInt(h)),
        ...disclosed.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalarOf(l))),
      ]).root,
    );
    expect(relabeledRoot, "the relabeled multiset must recompute the SAME root as the genuine artifact").toBe(genuineRoot);

    const attack: RedactedTagArtifact = {
      ...ENVELOPE,
      root: genuineRoot,
      disclosed,
      obfuscatedLeafHashes: relabeledObfuscated,
      reservedLeafHashes: relabeledReserved,
    };
    // Only the `reservedLeafHashes.length !== 3` check can reject this - the overlap check does not
    // fire (no disclosed hash collides with anything opaque) and the root matches exactly.
    expect(verifyRedactedArtifact(attack)).toBe(false);
  });

  it("rejects malformed hex shape in obfuscatedLeafHashes, reservedLeafHashes, and root - fail-closed, never throws", () => {
    const reserved = reservedHashes();
    const disclosed = [name(), microchip()];
    const root = computeRoot(reserved, [...disclosed, species()]);
    const base: RedactedTagArtifact = {
      ...ENVELOPE,
      root,
      disclosed,
      obfuscatedLeafHashes: [hashOf(species())],
      reservedLeafHashes: reserved,
    };

    const badObfuscated = {...base, obfuscatedLeafHashes: ["0xnothex"]};
    const badReserved = {...base, reservedLeafHashes: [reserved[0]!, reserved[1]!, "not-a-hash-at-all"]};
    const badRoot = {...base, root: "0xshort"};

    for (const bad of [badObfuscated, badReserved, badRoot]) {
      expect(() => verifyRedactedArtifact(bad)).not.toThrow();
      expect(verifyRedactedArtifact(bad)).toBe(false);
    }
  });

  // D4 bite proof: the malformed-hex fixtures above ("0xnothex", "not-a-hash-at-all", "0xshort") are
  // all rejected by fromHex32 THROWING (caught and turned into false) - the hex32 shape check itself
  // is never the thing under test. DISCREPANCY vs. the grade recipe's literal "0x12" suggestion,
  // logged in the progress LOG: "0x12" isolates TS's shape check (fromHex32 has no length check of
  // its own) but does NOT isolate Rust's - `from_hex32` (wrap.rs) independently enforces exactly-32-
  // bytes, so a wrong-length string is already rejected there with or without `is_hex32`. The
  // construction that isolates BOTH languages' shape check is a MISSING "0x" PREFIX on an otherwise
  // perfectly valid 64-hex-char hash: `isHex32`/`is_hex32` require the literal "0x" prefix, while
  // `fromHex32`/`from_hex32` treat it as OPTIONAL (strip if present, else use as-is) - so the exact
  // same numeric value round-trips through fromHex32/from_hex32 either way, and the root recomputes
  // identically whether or not the wire string happens to carry "0x".
  it("rejects a reservedLeafHashes entry MISSING its \"0x\" prefix (otherwise a perfectly valid, in-field 64-hex-char hash), with the root built over the SAME parsed value - only the hex32 shape check can reject this, since fromHex32/from_hex32 treat the prefix as optional and the root recomputes exactly", () => {
    const reserved = reservedHashes();
    const a = species();
    const noPrefixReserved0 = reserved[0]!.slice(2);
    expect(noPrefixReserved0.length, "guards a vacuous construction - must be exactly 64 hex chars").toBe(64);
    const genuineRoot = buildMerkle([...reserved.map((h) => BigInt(h)), bigHashOf(a)]).root;
    const artifact: RedactedTagArtifact = {
      ...ENVELOPE,
      root: toHex32(genuineRoot),
      disclosed: [a],
      obfuscatedLeafHashes: [],
      reservedLeafHashes: [noPrefixReserved0, reserved[1]!, reserved[2]!],
    };
    expect(verifyRedactedArtifact(artifact)).toBe(false);
  });

  it("rejects an obfuscatedLeafHashes entry MISSING its \"0x\" prefix (otherwise a perfectly valid, in-field 64-hex-char hash), with the root built over the SAME parsed value - only the hex32 shape check can reject this", () => {
    const reserved = reservedHashes();
    const a = species();
    const b = microchip();
    const hashA = bigHashOf(a);
    const noPrefixObfuscated = toHex32(hashA).slice(2);
    expect(noPrefixObfuscated.length, "guards a vacuous construction - must be exactly 64 hex chars").toBe(64);
    const genuineRoot = buildMerkle([...reserved.map((h) => BigInt(h)), hashA, bigHashOf(b)]).root;
    const artifact: RedactedTagArtifact = {
      ...ENVELOPE,
      root: toHex32(genuineRoot),
      disclosed: [b],
      obfuscatedLeafHashes: [noPrefixObfuscated],
      reservedLeafHashes: reserved,
    };
    expect(verifyRedactedArtifact(artifact)).toBe(false);
  });

  it("rejects more than 64 total leaves summed across disclosed + obfuscated + reserved", () => {
    const reserved = reservedHashes();
    const disclosed: OpenedLeaf[] = Array.from({length: 40}, (_, i) => opened(`credentialSubject.extra[${i}]`, (i % 250) + 1, TypeTag.String, `v${i}`));
    const obfuscatedLeafHashes: string[] = Array.from({length: 22}, (_, i) => toHex32(BigInt(i + 1)));
    // 3 reserved + 40 disclosed + 22 obfuscated = 65 > 64.
    const artifact: RedactedTagArtifact = {...ENVELOPE, root: toHex32(1n), disclosed, obfuscatedLeafHashes, reservedLeafHashes: reserved};
    expect(verifyRedactedArtifact(artifact)).toBe(false);
  });

  // D4 bite proof: the test above posts a root (toHex32(1n)) that cannot possibly match ANY real
  // 65-leaf multiset, so the ROOT CHECK alone already rejects it - the cap comparison never fires.
  // This one carries the GENUINE root of the actual 65-leaf multiset (3 reserved + 62 disclosed), so
  // only the 64-leaf cap comparison can reject it. Pairs with the existing exactly-64-leaf accept
  // ("accepts exactly at the 64-leaf cap" in the equivalence suite above).
  it("rejects 65 total leaves (one over the cap) carrying their OWN genuine root - only the 64-leaf cap can reject this, since the root recomputes exactly", () => {
    const reserved = reservedHashes();
    const many62: OpenedLeaf[] = Array.from({length: 62}, (_, i) => opened(`credentialSubject.extra[${i}]`, (i % 250) + 1, TypeTag.String, `v${i}`));
    const genuineRoot = computeRoot(reserved, many62); // 3 reserved + 62 disclosed = 65 total
    const artifact: RedactedTagArtifact = {...ENVELOPE, root: genuineRoot, disclosed: many62, obfuscatedLeafHashes: [], reservedLeafHashes: reserved};
    expect(verifyRedactedArtifact(artifact)).toBe(false);
  });

  it("fail-closed: never throws on a hostile/malformed disclosed opening even outside the equivalence-suite cases", () => {
    const reserved = reservedHashes();
    const artifact: RedactedTagArtifact = {
      ...ENVELOPE,
      root: toHex32(1n),
      disclosed: [{keyPath: "credentialSubject.name", saltHex: "0x01", tag: 99 as TypeTag, value: "Rex"}],
      obfuscatedLeafHashes: [],
      reservedLeafHashes: reserved,
    };
    expect(() => verifyRedactedArtifact(artifact)).not.toThrow();
    expect(verifyRedactedArtifact(artifact)).toBe(false);
  });

  it("DOCUMENTS (does not fix - frozen code, see below) a cross-language divergence for a malformed Bytes value: TS silently zero-fills non-hex characters instead of rejecting them", () => {
    // hexToBytes (src/encode.ts, frozen - HARD RULE: no semantic change to encoding) validates only
    // that the string has EVEN length; each 2-char chunk is fed to parseInt(chunk, 16), which returns
    // NaN for a non-hex chunk, and NaN silently coerces to 0 when written into a Uint8Array slot (JS
    // ToUint8 semantics) - so "zzzzzzzz" (8 non-hex characters, even length) decodes to 4 zero bytes
    // and NEVER throws. recomputeLeaf (redactedArtifact.ts) reaches this via scalarFromPacked
    // (wrap.ts) for any Bytes-tagged disclosed leaf, so verifyRedactedArtifact treats a malformed
    // Bytes opening as just another (misleading, but deterministic) encoding, not a parse failure.
    //
    // Rust's mirror does NOT agree: wrap.rs's scalar_from_packed decodes Bytes via `hex::decode`,
    // which returns Err for the identical "zzzzzzzz" input; redacted_artifact.rs's recompute_leaf
    // propagates that Err, and verify_redacted_artifact's `Err(_) => return false` (checked directly
    // against the Rust source, redacted_artifact.rs lines ~184-187) turns it into an outright
    // rejection regardless of what root is claimed. See
    // crates/dogtag-standard-rs/src/redacted_artifact.rs's
    // "documents_the_ts_side_malformed_bytes_divergence..." test for the Rust-side half of this proof.
    //
    // This is INHERITED via composition from a frozen primitive shared far outside this file's scope
    // (hexToBytes backs ordinary hashLeaf/verifyLeafCommitment usage too - it is not specific to
    // redacted artifacts), so it is proven and disclosed here rather than silently patched around:
    // fixing it would mean changing encode.ts, which both this task's HARD RULES and the blast radius
    // of that change (every caller of hexToBytes, not just this file) put out of scope for WP4.10S.
    expect(hexToBytes("zzzzzzzz")).toEqual(new Uint8Array([0, 0, 0, 0]));

    const reserved = reservedHashes();
    const malformedBytes = opened("credentialSubject.photoHash", 0xf0, TypeTag.Bytes, "zzzzzzzz");
    const explicitZeroBytes = opened("credentialSubject.photoHash", 0xf0, TypeTag.Bytes, "00000000");
    // Proves WHICH deterministic value TS actually lands on: bit-identical to explicit zero bytes.
    expect(computeRoot(reserved, [malformedBytes])).toBe(computeRoot(reserved, [explicitZeroBytes]));

    const root = computeRoot(reserved, [malformedBytes]);
    const artifact: RedactedTagArtifact = {...ENVELOPE, root, disclosed: [malformedBytes], obfuscatedLeafHashes: [], reservedLeafHashes: reserved};
    // TS accepts a self-consistently-built artifact carrying the malformed opening (never throws, per
    // this function's own fail-closed contract - this is a deliberate ACCEPT, not an escaped
    // exception): the SAME frozen hexToBytes call underlies both the root this test built and the
    // hash verifyRedactedArtifact recomputes, so the two necessarily agree.
    expect(verifyRedactedArtifact(artifact)).toBe(true);
  });

  it("FIXED (fix round 1 D2, grade wp4.14S-grade.md - was: DOCUMENTS, does not fix): a malformed (non-hex) saltHex on EVERY disclosed leaf, at EVERY TypeTag, is now REJECTED by verifyRedactedArtifact, closing the cross-language divergence this test used to document", () => {
    // hexToBytes ITSELF (src/encode.ts, frozen - HARD RULE: no semantic change to encoding) is
    // UNTOUCHED and exactly as lenient as before: it still zero-fills a non-hex-but-even-length string
    // rather than throwing. What changed in this fix round is NOT hexToBytes - it is recomputeLeaf
    // (redactedArtifact.ts, NOT frozen), which now checks saltHex against isMalformedSaltHex BEFORE
    // ever calling hexToBytes, so a malformed salt never reaches the lenient primitive at all. The
    // original comment here framed this as "does not fix - frozen code," which conflated "hexToBytes
    // itself cannot be fixed" (still true) with "therefore verifyRedactedArtifact's behavior on this
    // input cannot be fixed either" (false - the caller can guard its own input before handing it to a
    // frozen primitive, which is exactly what recomputeLeaf now does). This is a genuinely NEW
    // divergence from profileBind.ts's own frozen recomputeLeaf, which this file's recomputeLeaf
    // otherwise mirrors - see plans/orchestration/wp4.14S-progress.md's deviations for that disclosure.
    const malformedSalt = "0x" + "z".repeat(32);
    expect(hexToBytes(malformedSalt)).toEqual(new Uint8Array(16)); // hexToBytes's own leniency: unchanged.

    const reserved = reservedHashes();
    const malformedSaltLeaf: OpenedLeaf = {keyPath: "credentialSubject.name", saltHex: malformedSalt, tag: TypeTag.String, value: "Rex"};
    const explicitZeroSaltLeaf: OpenedLeaf = {...malformedSaltLeaf, saltHex: "0x" + "00".repeat(16)};
    // hexToBytes would still land on the same deterministic (wrong) zero-fill if it were ever called -
    // but recomputeLeaf's new guard means it never is, for the malformed leaf, so the two roots below
    // are still bit-identical (both computed via the frozen primitive, off-verifier, for comparison
    // purposes only) even though verifyRedactedArtifact now treats the two leaves very differently.
    expect(computeRoot(reserved, [malformedSaltLeaf])).toBe(computeRoot(reserved, [explicitZeroSaltLeaf]));

    const root = computeRoot(reserved, [malformedSaltLeaf]);
    const artifact: RedactedTagArtifact = {...ENVELOPE, root, disclosed: [malformedSaltLeaf], obfuscatedLeafHashes: [], reservedLeafHashes: reserved};
    // TS now REJECTS (recomputeLeaf throws before hexToBytes is ever reached; verifyRedactedArtifact's
    // fail-closed try/catch turns that into `false`) - matching the Rust mirror, which already rejected
    // outright on the identical input; see redacted_artifact.rs's
    // "rejects_a_malformed_salt_hex_on_every_typetag_fix_round_1_d2" test for the Rust-side half.
    expect(verifyRedactedArtifact(artifact)).toBe(false);
  });

  it("fix round 1 D2: a genuinely well-formed (hex, even-length, any length) saltHex still recomputes and verifies normally - the new guard only rejects, never additionally accepts or changes a correct root", () => {
    const reserved = reservedHashes();
    const wellFormed: OpenedLeaf = {keyPath: "credentialSubject.name", saltHex: "0x" + "ab".repeat(16), tag: TypeTag.String, value: "Rex"};
    const root = computeRoot(reserved, [wellFormed]);
    const artifact: RedactedTagArtifact = {...ENVELOPE, root, disclosed: [wellFormed], obfuscatedLeafHashes: [], reservedLeafHashes: reserved};
    expect(verifyRedactedArtifact(artifact)).toBe(true);
  });

  it("fix round 1 D2: accepts a saltHex without the 0x prefix (the shape specs/leaf-commitment-vectors.json's own saltHex entries actually use) - the guard does not require the prefix, only hex digits at even length", () => {
    const reserved = reservedHashes();
    const noPrefix: OpenedLeaf = {keyPath: "credentialSubject.name", saltHex: "ab".repeat(16), tag: TypeTag.String, value: "Rex"};
    const root = computeRoot(reserved, [noPrefix]);
    const artifact: RedactedTagArtifact = {...ENVELOPE, root, disclosed: [noPrefix], obfuscatedLeafHashes: [], reservedLeafHashes: reserved};
    expect(verifyRedactedArtifact(artifact)).toBe(true);
  });
});

// WP4.14S (advisor round 2 item 3): the two sibling opened-leaf formats are policy-incompatible by
// CONSTRUCTION, not merely by prose - specs/leaf-commitment.md section 16's "Relation to redacted (tag)
// artifacts" states a receiver must pick the right verifier from `artifactType` because a payload
// cannot cross-accept. recordArtifact.test.ts's "rejects three reserved hashes too" already proves one
// direction (a RedactedTagArtifact-shaped 3-reserved-hash artifact fails verifyRecordArtifact); this is
// the other direction.
describe("cross-verifier: verifyRedactedArtifact rejects a genuine RecordArtifact's shape (specs/leaf-commitment.md section 16 \"Relation to redacted (tag) artifacts\")", () => {
  it("rejects reservedLeafHashes: [] even when the root genuinely folds over exactly that (record-shaped) leaf set - a RecordArtifact's own invariant is never an acceptable RedactedTagArtifact", () => {
    // A record-shaped leaf set (no reserved triple folded in at all, unlike every fixture above) -
    // this artifact's root is genuinely the buildMerkle root of its OWN posted leaves, isolating the
    // exactly-3-reserved-count check rather than merely failing on a root mismatch.
    const recordLikeLeaves = [
      opened("credentialSubject.dogTagId", 1, TypeTag.String, "424242"),
      opened("recordType", 2, TypeTag.String, "VACCINATION"),
      opened("credentialSchema.id", 3, TypeTag.String, "https://dogtag.io/schemas/vaccination/v1"),
      ...petOpenings(),
    ];
    const root = computeRoot([], recordLikeLeaves);
    const artifact: RedactedTagArtifact = {...ENVELOPE, root, disclosed: recordLikeLeaves, obfuscatedLeafHashes: [], reservedLeafHashes: []};
    expect(verifyRedactedArtifact(artifact)).toBe(false);
  });
});
