// Generate the shared testvectors.json (impl §9) — inputs -> expected leaf hashes, roots, proofs.
// The TS SDK is the reference; crates/dogtag-standard-rs asserts the SAME file in CI, guaranteeing
// cross-language determinism. Salts are FIXED here so vectors are reproducible.
import {writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
  FIELD_P,
  TypeTag,
  bytesToField,
  buildMerkle,
  hashLeaf,
  merkleProof,
  verifyInclusion,
  verifyRedactedArtifact,
  scalarFromPacked,
  toHex32,
  type OpenedLeaf,
  type ProofStep,
  type RedactedTagArtifact,
  type TypedScalar,
} from "../src/index.js";
import {hexToBytes, bytesToHex} from "../src/encode.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function salt(n: number): Uint8Array {
  // deterministic 16-byte salt: 0x{nn} repeated
  const s = new Uint8Array(16).fill(n & 0xff);
  return s;
}

interface LeafVec {
  name: string;
  keyPath: string;
  saltHex: string;
  tag: number;
  // value encoding: for Bytes (5) -> hex string; else -> string; null -> null
  value: string | null;
  expected_hex: string;
}

function leafVec(name: string, keyPath: string, s: Uint8Array, scalar: TypedScalar): LeafVec {
  const h = hashLeaf(keyPath, s, scalar);
  let value: string | null;
  if (scalar.tag === TypeTag.Null) value = null;
  else if (scalar.tag === TypeTag.Bytes) value = bytesToHex(scalar.value);
  else if (scalar.tag === TypeTag.Bool) value = scalar.value ? "true" : "false";
  else value = scalar.value;
  return {name, keyPath, saltHex: bytesToHex(s), tag: scalar.tag, value, expected_hex: toHex32(h)};
}

const leaves: LeafVec[] = [
  leafVec("null", "a.b", salt(1), {tag: TypeTag.Null, value: null}),
  leafVec("bool_true", "flags.active", salt(2), {tag: TypeTag.Bool, value: true}),
  leafVec("bool_false", "flags.lost", salt(3), {tag: TypeTag.Bool, value: false}),
  leafVec("string_basic", "credentialSubject.name", salt(4), {tag: TypeTag.String, value: "Rex"}),
  // tag 2 "5" must differ from tag 3 5 (mandatory negative — §11.2)
  leafVec("string_five", "x", salt(5), {tag: TypeTag.String, value: "5"}),
  leafVec("integer_five", "x", salt(5), {tag: TypeTag.Integer, value: "5"}),
  // microchip is a 15-digit STRING with leading-zero preservation
  leafVec("microchip", "credentialSubject.microchip.code", salt(6), {
    tag: TypeTag.String,
    value: "985141006580311",
  }),
  leafVec("microchip_leadingzero", "credentialSubject.microchip.code", salt(7), {
    tag: TypeTag.String,
    value: "012345678901234",
  }),
  // decimals from the spec
  leafVec("decimal_weight", "weightHistory[0].value", salt(8), {tag: TypeTag.Decimal, value: "22.7"}),
  leafVec("decimal_titer", "titer.resultIUml", salt(9), {tag: TypeTag.Decimal, value: "0.5"}),
  leafVec("decimal_trailingzeros", "w", salt(10), {tag: TypeTag.Decimal, value: "22.70"}), // == 22.7
  // a timestamp value containing ":" (first-two-colons parse must survive in `data`)
  leafVec("timestamp", "vaccinationDate", salt(11), {tag: TypeTag.String, value: "2026-06-17T14:46:29Z"}),
  // NFC combining sequence normalizes to its composed form
  leafVec("nfc_combining", "note", salt(12), {tag: TypeTag.String, value: "é"}), // -> é
  leafVec("bytes", "photoHashes[0]", salt(13), {tag: TypeTag.Bytes, value: hexToBytes("deadbeef") as never}),
  // a large string spanning multiple 31-byte limbs
  leafVec("long_string", "taskDescription", salt(14), {tag: TypeTag.String, value: "x".repeat(200)}),
];

// bytesToField edge vectors (impl §11.10(d))
const btf = [
  {name: "empty", inputHex: ""},
  {name: "a", inputHex: bytesToHex(new TextEncoder().encode("a"))},
  {name: "a_nul", inputHex: bytesToHex(new TextEncoder().encode("a\x00"))},
  {name: "31_bytes", inputHex: "ab".repeat(31)},
  {name: "32_bytes", inputHex: "cd".repeat(32)},
].map((v) => ({...v, expected_hex: toHex32(bytesToField(hexToBytes(v.inputHex)))}));

// Merkle vectors at sizes 1..9 (odd promotion + single-leaf root), plus a commutativity swap.
function leafSet(k: number): bigint[] {
  const out: bigint[] = [];
  for (let i = 0; i < k; i++) {
    out.push(hashLeaf(`leaf${i}`, salt(100 + i), {tag: TypeTag.Integer, value: String(i)}));
  }
  return out;
}
const merkle = [];
for (let k = 1; k <= 9; k++) {
  const set = leafSet(k);
  const {root} = buildMerkle(set);
  merkle.push({name: `size_${k}`, leaf_hexes: set.map(toHex32), root_hex: toHex32(root)});
}
// commutativity: reversed input order -> same root
{
  const set = leafSet(2);
  const a = buildMerkle(set).root;
  const b = buildMerkle([...set].reverse()).root;
  merkle.push({name: "commutativity_2", leaf_hexes: set.map(toHex32), root_hex: toHex32(a), reversed_root_hex: toHex32(b)});
}
// obfuscation invariance: dropping a cleartext leaf into `obfuscated` keeps the SAME root,
// because the root is over the SAME leaf-hash multiset.
{
  const set = leafSet(5);
  merkle.push({name: "obfuscation_5_same_root", leaf_hexes: set.map(toHex32), root_hex: toHex32(buildMerkle(set).root)});
}

// ---- Inclusion proofs (DSDP plan §2.3): the `Sibling | Promote` generate/verify conformance. ----
// The reference vectors M1 rests on. Shared Rust↔TS↔Swift: each verifier RECOMPUTES the leaf from
// (keyPath, salt, tag, value) under DS_LEAF, folds the root-ward steps (sibling→Poseidon3(DS_NODE),
// promote→pass-through), and MUST agree with `valid`. Coverage: every leaf of every tree in the
// audit's leaf counts {1,2,3,5,6,7,13,24,34} (so multi-level promotion — the sorted-last leaf of an
// odd tree promotes at consecutive levels — is exercised end-to-end), a mixed-leaf-type tree (proves
// recompute-from-fields across tags in the inclusion path), and negatives (tampered value, corrupted
// sibling, wrong root) that MUST cleanly return false. This generator self-checks every vector.
const INCLUSION_COUNTS = [1, 2, 3, 5, 6, 7, 13, 24, 34];

interface LeafRecord {
  keyPath: string;
  salt: Uint8Array;
  scalar: TypedScalar;
}

interface InclusionVec {
  name: string;
  leafCount: number;
  keyPath: string;
  saltHex: string;
  tag: number;
  value: string | null;
  steps: ({sibling: string} | {promote: true})[];
  root: string;
  promotes: number; // # of Promote steps (drives the "multi-level promotion exercised" assertion)
  valid: boolean;
}

/** Serialize the in-memory ProofStep[] to the wire shape (plan §4.4). */
function stepsToJson(steps: ProofStep[]): ({sibling: string} | {promote: true})[] {
  return steps.map((s) => ("sibling" in s ? {sibling: toHex32(s.sibling)} : ({promote: true} as const)));
}

/** The packed `value` field as it appears in the vector JSON (mirror of `leafVec`). */
function valueOf(scalar: TypedScalar): string | null {
  if (scalar.tag === TypeTag.Null) return null;
  if (scalar.tag === TypeTag.Bytes) return bytesToHex(scalar.value);
  if (scalar.tag === TypeTag.Bool) return scalar.value ? "true" : "false";
  return scalar.value;
}

function intLeafRecord(i: number): LeafRecord {
  return {keyPath: `leaf${i}`, salt: salt(100 + i), scalar: {tag: TypeTag.Integer, value: String(i)}};
}

const inclusion: InclusionVec[] = [];

function pushValid(name: string, leafCount: number, r: LeafRecord, steps: ProofStep[], root: bigint) {
  if (!verifyInclusion(r.keyPath, r.salt, r.scalar, steps, root)) {
    throw new Error(`gen: valid inclusion vector ${name} failed to verify`);
  }
  inclusion.push({
    name,
    leafCount,
    keyPath: r.keyPath,
    saltHex: bytesToHex(r.salt),
    tag: r.scalar.tag,
    value: valueOf(r.scalar),
    steps: stepsToJson(steps),
    root: toHex32(root),
    promotes: steps.filter((s) => "promote" in s).length,
    valid: true,
  });
}

for (const k of INCLUSION_COUNTS) {
  const records = Array.from({length: k}, (_, i) => intLeafRecord(i));
  const hashes = records.map((r) => hashLeaf(r.keyPath, r.salt, r.scalar));
  const {root, layers} = buildMerkle(hashes);
  const proofs = hashes.map((h) => merkleProof(layers, h));
  records.forEach((r, i) => pushValid(`size_${k}_${r.keyPath}`, k, r, proofs[i]!, root));

  // Negatives for sizes that span promotion depth {5,7,24}: aim them at the leaf with the MOST
  // promote steps so the tampered/corrupted paths also traverse multi-level promotion.
  if (k === 5 || k === 7 || k === 24) {
    let ti = 0;
    for (let i = 1; i < k; i++) {
      if (proofs[i]!.filter((s) => "promote" in s).length > proofs[ti]!.filter((s) => "promote" in s).length) ti = i;
    }
    const r = records[ti]!;
    const steps = proofs[ti]!;

    // (1) tampered value: recomputes a different leaf that will not fold to root.
    const tamperedScalar: TypedScalar = {tag: TypeTag.Integer, value: `${ti}7`};
    if (verifyInclusion(r.keyPath, r.salt, tamperedScalar, steps, root)) throw new Error(`gen: tampered ${k}/${ti} still verified`);
    inclusion.push({
      name: `size_${k}_${r.keyPath}_tampered_value`,
      leafCount: k, keyPath: r.keyPath, saltHex: bytesToHex(r.salt), tag: TypeTag.Integer,
      value: `${ti}7`, steps: stepsToJson(steps), root: toHex32(root),
      promotes: steps.filter((s) => "promote" in s).length, valid: false,
    });

    // (2) corrupted sibling: replace the first real sibling with a DIFFERENT real field element
    // (a valid leaf hash not in this tree) so all three languages reject cleanly (never throw).
    const bogus = hashLeaf("bogus_sibling", salt(240), {tag: TypeTag.Integer, value: "999999"});
    const sibIdx = steps.findIndex((s) => "sibling" in s);
    if (sibIdx >= 0) {
      const corrupted: ProofStep[] = steps.map((s, j) => (j === sibIdx ? {sibling: bogus} : s));
      if (verifyInclusion(r.keyPath, r.salt, r.scalar, corrupted, root)) throw new Error(`gen: corrupted sibling ${k}/${ti} still verified`);
      inclusion.push({
        name: `size_${k}_${r.keyPath}_corrupted_sibling`,
        leafCount: k, keyPath: r.keyPath, saltHex: bytesToHex(r.salt), tag: TypeTag.Integer,
        value: valueOf(r.scalar), steps: stepsToJson(corrupted), root: toHex32(root),
        promotes: corrupted.filter((s) => "promote" in s).length, valid: false,
      });
    }

    // (3) wrong root: correct leaf + steps, but the root of a DIFFERENT tree.
    const otherRoot = buildMerkle(leafSet(k + 1)).root;
    if (verifyInclusion(r.keyPath, r.salt, r.scalar, steps, otherRoot)) throw new Error(`gen: wrong root ${k}/${ti} still verified`);
    inclusion.push({
      name: `size_${k}_${r.keyPath}_wrong_root`,
      leafCount: k, keyPath: r.keyPath, saltHex: bytesToHex(r.salt), tag: TypeTag.Integer,
      value: valueOf(r.scalar), steps: stepsToJson(steps), root: toHex32(otherRoot),
      promotes: steps.filter((s) => "promote" in s).length, valid: false,
    });
  }
}

// Mixed-leaf-type tree (size 6): disclose one leaf of each representative tag through an inclusion
// proof, proving recompute-from-fields works across tags (not just integers) in the fold path.
{
  const mixed: LeafRecord[] = [
    {keyPath: "credentialSubject.dogTagId", salt: salt(150), scalar: {tag: TypeTag.Integer, value: "42"}},
    {keyPath: "credentialSubject.name", salt: salt(151), scalar: {tag: TypeTag.String, value: "Rex"}},
    {keyPath: "flags.lost", salt: salt(152), scalar: {tag: TypeTag.Bool, value: false}},
    {keyPath: "weightHistory[0].value", salt: salt(153), scalar: {tag: TypeTag.Decimal, value: "22.7"}},
    {keyPath: "photoHashes[0]", salt: salt(154), scalar: {tag: TypeTag.Bytes, value: hexToBytes("deadbeef")}},
    {keyPath: "note", salt: salt(155), scalar: {tag: TypeTag.Null, value: null}},
  ];
  const hashes = mixed.map((r) => hashLeaf(r.keyPath, r.salt, r.scalar));
  const {root, layers} = buildMerkle(hashes);
  mixed.forEach((r, i) => pushValid(`mixed6_${r.keyPath}`, mixed.length, r, merkleProof(layers, hashes[i]!), root));
}

if (!inclusion.some((v) => v.valid && v.promotes >= 2)) {
  throw new Error("gen: no inclusion vector exercises multi-level promotion (>= 2 Promote steps)");
}

// --- Redacted-artifact vectors (WP4.10S item 3: shared TS/Rust parity fixture) ---
// Exercises `verifyRedactedArtifact` over a small 3-attribute profile (name/species/
// microchip.code - the same keyPaths merkleVectors[0] uses) plus 3 reserved owner-control hashes
// and 3 owner.identity.* attributes, masked various ways. Every vector is SELF-CHECKED against the
// real `verifyRedactedArtifact` before being written (never hand-computed), exactly like the
// inclusion vectors above.
interface RedactedArtifactWireLeaf {
  keyPath: string;
  saltHex: string;
  tag: number;
  value: string;
}

interface RedactedArtifactVec {
  name: string;
  notes: string;
  disclosed: RedactedArtifactWireLeaf[];
  obfuscatedLeafHashes: string[];
  reservedLeafHashes: string[];
  root: string;
  expectedIdentityLeaves?: RedactedArtifactWireLeaf[];
  valid: boolean;
}

function raLeaf(keyPath: string, s: Uint8Array, value: string): OpenedLeaf {
  return {keyPath, saltHex: bytesToHex(s), tag: TypeTag.String, value};
}

// Every OTHER redactedArtifacts vector below discloses String-tagged (tag 2) leaves only, because
// they exist to exercise verifyRedactedArtifact's STRUCTURAL checks (counts, overlap, duplicate
// keyPath, root recompute), not per-tag encoding - leafHashVectors already covers per-tag encoding
// exhaustively on its own. But the cross-language PARITY claim this file backs
// (redacted_artifact_parity.rs) is "the same VERDICT for the same artifact," and encoding is exactly
// where two independent implementations are most likely to silently diverge (WP4.10S grading pass:
// every disclosed leaf across all 8 original vectors was tag 2, so tags 0/1/3/4/5 were asserted
// identical by claim only, never actually exercised cross-language). raLeafTagged plus the vector
// below closes that: one artifact disclosing all 6 TypeTags at once, self-checked here exactly like
// every other vector, then asserted by both languages via the same shared file.
function raLeafTagged(keyPath: string, s: Uint8Array, tag: TypeTag, value: string): OpenedLeaf {
  return {keyPath, saltHex: bytesToHex(s), tag, value};
}

function raWire(l: OpenedLeaf): RedactedArtifactWireLeaf {
  return {keyPath: l.keyPath, saltHex: l.saltHex, tag: l.tag, value: l.value};
}

function raHash(l: OpenedLeaf): bigint {
  // scalarFromPacked (not a naive {tag, value} cast) - the wire OpenedLeaf.value is always a STRING
  // (e.g. Bytes is hex text, Null is ""), and only scalarFromPacked decodes it into the shape
  // hashLeaf actually expects per tag (Uint8Array for Bytes, literal null for Null, etc.) - the exact
  // same conversion recomputeLeaf (redactedArtifact.ts) and recompute_leaf (Rust) perform. A naive
  // cast happened to work for the String/Integer/Decimal-only vectors above (their wire value IS
  // already the correct TypedScalar.value), which is exactly why this only surfaced once a
  // Null/Bool/Bytes-tagged leaf was added below.
  return hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalarFromPacked(l.tag, l.value));
}

function raArtifact(
  root: string,
  disclosed: OpenedLeaf[],
  obfuscatedLeafHashes: string[],
  reservedLeafHashes: string[],
): RedactedTagArtifact {
  return {
    protocolVersion: "dogtag-v2/1",
    dogTagIdField: "1",
    issuerClone: "0x" + "11".repeat(20),
    root,
    disclosed,
    obfuscatedLeafHashes,
    reservedLeafHashes,
  };
}

function raRootOver(disclosed: OpenedLeaf[], obfuscated: string[], reserved: string[]): bigint {
  const leafHashes = [...reserved.map((h) => BigInt(h)), ...obfuscated.map((h) => BigInt(h)), ...disclosed.map(raHash)];
  return buildMerkle(leafHashes).root;
}

const raName = raLeaf("credentialSubject.name", salt(0xaa), "Rex");
const raSpecies = raLeaf("credentialSubject.species", salt(0xbb), "dog");
const raMicrochip = raLeaf("credentialSubject.microchip.code", salt(0xcc), "985141006580319");
const raIdentity = [
  raLeaf("owner.identity.fullName", salt(0xd1), "Alice Owner"),
  raLeaf("owner.identity.country", salt(0xd2), "GB"),
  raLeaf("owner.identity.docNumber", salt(0xd3), "PASSPORT-123"),
];
const raReserved = [
  toHex32(hashLeaf("owner.address", salt(0xe1), {tag: TypeTag.Bytes, value: new Uint8Array([1])})),
  toHex32(hashLeaf("owner.consentKey", salt(0xe2), {tag: TypeTag.Bytes, value: new Uint8Array([2])})),
  toHex32(hashLeaf("owner.secret", salt(0xe3), {tag: TypeTag.Bytes, value: new Uint8Array([3])})),
];

const redactedArtifacts: RedactedArtifactVec[] = [];

function pushRedacted(
  name: string,
  notes: string,
  disclosed: OpenedLeaf[],
  obfuscatedLeafHashes: string[],
  reservedLeafHashes: string[],
  root: bigint,
  valid: boolean,
  expectedIdentityLeaves?: OpenedLeaf[],
) {
  const rootHex = toHex32(root);
  const artifact = raArtifact(rootHex, disclosed, obfuscatedLeafHashes, reservedLeafHashes);
  const got = verifyRedactedArtifact(artifact, expectedIdentityLeaves ? {expectedIdentityLeaves} : {});
  if (got !== valid) {
    throw new Error(`gen: redacted-artifact vector ${name} expected valid=${valid} but verifyRedactedArtifact returned ${got}`);
  }
  redactedArtifacts.push({
    name,
    notes,
    disclosed: disclosed.map(raWire),
    obfuscatedLeafHashes,
    reservedLeafHashes,
    root: rootHex,
    ...(expectedIdentityLeaves ? {expectedIdentityLeaves: expectedIdentityLeaves.map(raWire)} : {}),
    valid,
  });
}

{
  const fullRoot = raRootOver([raName, raSpecies, raMicrochip], [], raReserved);

  pushRedacted(
    "full_artifact_nothing_obfuscated",
    "The degenerate case: every attribute disclosed, obfuscatedLeafHashes empty.",
    [raName, raSpecies, raMicrochip],
    [],
    raReserved,
    fullRoot,
    true,
  );

  pushRedacted(
    "species_obfuscated",
    "species masked into obfuscatedLeafHashes; root is IDENTICAL to full_artifact_nothing_obfuscated (masking never moves R).",
    [raName, raMicrochip],
    [toHex32(raHash(raSpecies))],
    raReserved,
    fullRoot,
    true,
  );

  pushRedacted(
    "fully_obfuscated_disclosed_empty",
    "Every attribute masked (disclosed: []) - proves this artifact type has NO non-maskable attribute keyPath (WP4.10S item 1).",
    [],
    [toHex32(raHash(raName)), toHex32(raHash(raSpecies)), toHex32(raHash(raMicrochip))],
    raReserved,
    fullRoot,
    true,
  );

  const identityRoot = raRootOver([raName, ...raIdentity], [], raReserved);
  pushRedacted(
    "with_matching_identity_oracle",
    "owner.identity.* leaves disclosed and cross-checked against expectedIdentityLeaves (generalizes verifyLeafCommitment's mandatory check).",
    [raName, ...raIdentity],
    [],
    raReserved,
    identityRoot,
    true,
    raIdentity,
  );

  // --- Negatives ---

  pushRedacted(
    "negative_overlap",
    "species claimed BOTH disclosed and separately obfuscated - rejected on overlap even though every individual hash is genuine.",
    [raName, raSpecies, raMicrochip],
    [toHex32(raHash(raSpecies))],
    raReserved,
    fullRoot,
    false,
  );

  const relabeledReserved = raReserved.slice(0, 2);
  const relabeledObfuscated = [toHex32(raHash(raSpecies)), raReserved[2]!];
  const relabeledRoot = raRootOver([raName, raMicrochip], relabeledObfuscated, relabeledReserved);
  if (toHex32(relabeledRoot) !== toHex32(fullRoot)) {
    throw new Error("gen: reserved-relabel vector's naive multiset must recompute the SAME root as the genuine artifact");
  }
  pushRedacted(
    "negative_reserved_relabeled_as_obfuscated",
    "One reserved hash moved into obfuscatedLeafHashes instead: the naive leaf multiset (and hence buildMerkle's root) is IDENTICAL to species_obfuscated's, so only the exactly-3-reserved count check rejects this - the real non-maskable invariant this artifact type has (WP4.10S item 1), never a keyPath rule.",
    [raName, raMicrochip],
    relabeledObfuscated,
    relabeledReserved,
    fullRoot,
    false,
  );

  pushRedacted(
    "negative_wrong_root",
    "Correct disclosed/obfuscated/reserved split, but a root belonging to a different artifact entirely.",
    [raName, raMicrochip],
    [toHex32(raHash(raSpecies))],
    raReserved,
    999999n,
    false,
  );

  pushRedacted(
    "negative_two_reserved_hashes",
    "Only 2 reserved hashes posted (the frozen profile tree always has exactly 3).",
    [raName, raSpecies, raMicrochip],
    [],
    raReserved.slice(0, 2),
    fullRoot,
    false,
  );

  // Full TypeTag coverage: one artifact disclosing all 6 tags at once (String was already covered
  // above; this adds Null, Bool, Integer, Decimal, Bytes) - closes the parity gap where every prior
  // vector's disclosed leaves were tag 2 only, so per-tag decode agreement between
  // recomputeLeaf (TS) and recompute_leaf (Rust) was asserted by claim, never actually exercised
  // cross-language for tags 0/1/3/4/5.
  const raNickname = raLeafTagged("credentialSubject.nickname", salt(0xf0), TypeTag.Null, "");
  const raImplanted = raLeafTagged("credentialSubject.microchip.implanted", salt(0xf1), TypeTag.Bool, "true");
  const raIssuedYear = raLeafTagged("credentialSubject.microchip.issuedYear", salt(0xf2), TypeTag.Integer, "2021");
  const raWeightKg = raLeafTagged("credentialSubject.weightKg", salt(0xf3), TypeTag.Decimal, "22.7");
  const raPhotoHash = raLeafTagged("credentialSubject.photoHash", salt(0xf4), TypeTag.Bytes, "deadbeef");
  const allTagsDisclosed = [raName, raNickname, raImplanted, raIssuedYear, raWeightKg, raPhotoHash];
  const allTagsRoot = raRootOver(allTagsDisclosed, [], raReserved);
  pushRedacted(
    "all_six_type_tags_disclosed",
    "One disclosed leaf per TypeTag (0 Null, 1 Bool, 2 String, 3 Integer, 4 Decimal, 5 Bytes) - proves recomputeLeaf/recompute_leaf agree on EVERY tag's wire decoding, not just String (every other vector in this section discloses String-tagged leaves exclusively).",
    allTagsDisclosed,
    [],
    raReserved,
    allTagsRoot,
    true,
  );

  // --- D4 bite-proof negatives (WP4.10S fix round 1) ---
  // grade round 1 mutation-tested every negative vector above by deleting one normative check at a
  // time and re-running the full suite: the overlap check, the duplicate-keyPath guard, the 64-leaf
  // cap, and both opaque-hash shape checks could each be deleted outright with every vector above
  // (and both languages' full test suites) still passing, because a DIFFERENT check (usually the root
  // comparison) happens to reject the same construction for an unrelated reason. Each vector below is
  // built so the posted root is the GENUINE root of the EXACT multiset verifyRedactedArtifact folds -
  // the only check able to reject it is the one it names.

  // D2/D4#1: species genuinely committed TWICE - the device tree builder (build_profile_tree) only
  // guards the 3 reserved keyPaths, never cross-attribute uniqueness, so a real tree may commit to the
  // same attribute leaf hash twice. One copy disclosed, the other separately obfuscated: only the
  // overlap check's OBFUSCATED-half comparison can reject this.
  const dupObfuscatedRoot = raRootOver([raSpecies, raMicrochip], [toHex32(raHash(raSpecies))], raReserved);
  pushRedacted(
    "negative_overlap_root_preserving_duplicate_leaf",
    "species genuinely committed TWICE (a legitimate duplicate attribute leaf - build_profile_tree enforces keyPath uniqueness only against the 3 reserved keyPaths): one copy disclosed, the other separately obfuscated. The root recomputes EXACTLY; only the overlap check (obfuscated half) can reject this (D2/D4 bite proof).",
    [raSpecies, raMicrochip],
    [toHex32(raHash(raSpecies))],
    raReserved,
    dupObfuscatedRoot,
    false,
  );

  // D3/D4#2: reservedLeafHashes[0] deliberately set equal to a disclosed leaf's recomputed hash -
  // tests the VERIFIER's behavior on this wire input (unreachable via a genuine tree without a
  // Poseidon preimage: hash_reserved_leaf's raw-field slot cannot equal hashLeaf's output). Only the
  // overlap check's RESERVED-half comparison can reject this. The identical input is ACCEPTED by
  // verifyLeafCommitment (TS-only; see redacted_artifact.test.ts for that half of the proof) - the
  // exact divergence D3 documents.
  const reservedHalfHexes = [toHex32(raHash(raSpecies)), raReserved[1]!, raReserved[2]!];
  const reservedHalfRoot = raRootOver([raSpecies, raMicrochip], [], reservedHalfHexes);
  pushRedacted(
    "negative_overlap_reserved_half_matches_disclosed",
    "reservedLeafHashes[0] deliberately equals a disclosed leaf's recomputed hash. The root recomputes EXACTLY; only the overlap check (reserved half) can reject this - and the identical input is ACCEPTED by verifyLeafCommitment (D3's documented, safe-direction-only divergence).",
    [raSpecies, raMicrochip],
    [],
    reservedHalfHexes,
    reservedHalfRoot,
    false,
  );

  // D4#3: credentialSubject.name disclosed TWICE with DIFFERENT salts (both genuinely fold into the
  // root - not a malformed posting), no identity oracle supplied (irrelevant regardless: not an
  // owner.identity.* keyPath). Only the duplicate-keyPath guard can reject this.
  const raNameDupA = raLeaf("credentialSubject.name", salt(0x10), "Rex");
  const raNameDupB = raLeaf("credentialSubject.name", salt(0x20), "Rex");
  const dupKeyPathRoot = raRootOver([raNameDupA, raNameDupB], [], raReserved);
  pushRedacted(
    "negative_duplicate_pet_keypath_no_identity_oracle",
    "credentialSubject.name disclosed TWICE with different salts (both genuinely fold into the root), no identity oracle supplied so the identity multiset check cannot mask it. Only the duplicate-keyPath guard can reject this, since the root recomputes exactly (D4 bite proof).",
    [raNameDupA, raNameDupB],
    [],
    raReserved,
    dupKeyPathRoot,
    false,
  );

  // D4#4: 65 total leaves (3 reserved + 62 disclosed), one over the 64-leaf cap, carrying their OWN
  // genuine root. Only the cap comparison can reject this. Pairs with all_six_type_tags_disclosed /
  // full_artifact_nothing_obfuscated as under-cap accepts.
  const many62 = Array.from({length: 62}, (_, i) => raLeaf(`credentialSubject.extra[${i}]`, salt(i + 1), `v${i}`));
  const cap65Root = raRootOver(many62, [], raReserved);
  pushRedacted(
    "negative_65_leaves_genuine_root_over_cap",
    "65 total leaves (3 reserved + 62 disclosed), one over the 64-leaf cap, carrying their OWN genuine root. Only the cap comparison can reject this, since the root recomputes exactly (D4 bite proof).",
    many62,
    [],
    raReserved,
    cap65Root,
    false,
  );

  // D4#5: a reservedLeafHashes/obfuscatedLeafHashes entry MISSING its "0x" prefix (otherwise a
  // perfectly valid, in-field 64-hex-char hash), root built over the SAME parsed value.
  // DISCREPANCY vs. the grade recipe's literal "0x12" (wrong-length) suggestion, logged in the
  // progress LOG: "0x12" isolates TS's shape check (fromHex32 has no length check of its own) but does
  // NOT isolate Rust's - from_hex32 (wrap.rs) independently enforces exactly-32-bytes, so a
  // wrong-length string is already rejected there with or without is_hex32 (confirmed empirically: the
  // "0x12" construction survived the is_hex32-deleted mutant in Rust - a false bite proof, corrected
  // here). The missing-"0x"-prefix construction isolates BOTH languages' shape check: isHex32/is_hex32
  // require the literal "0x" prefix, while fromHex32/from_hex32 treat it as OPTIONAL (strip if present,
  // else use the string as-is), so the identical numeric value round-trips either way.
  const noPrefixReserved0 = raReserved[0]!.slice(2);
  const reservedShapeRoot = raRootOver([raSpecies], [], raReserved);
  pushRedacted(
    "negative_hex32_shape_reserved_missing_0x_prefix",
    "reservedLeafHashes[0] missing its \"0x\" prefix (otherwise a perfectly valid, in-field 64-hex-char hash), root built over the SAME parsed value. Only the hex32 shape check can reject this (D4 bite proof).",
    [raSpecies],
    [],
    [noPrefixReserved0, raReserved[1]!, raReserved[2]!],
    reservedShapeRoot,
    false,
  );

  const noPrefixObfuscated = toHex32(raHash(raSpecies)).slice(2);
  const obfuscatedShapeRoot = raRootOver([raMicrochip], [toHex32(raHash(raSpecies))], raReserved);
  pushRedacted(
    "negative_hex32_shape_obfuscated_missing_0x_prefix",
    "obfuscatedLeafHashes[0] missing its \"0x\" prefix (otherwise a perfectly valid, in-field 64-hex-char hash), root built over the SAME parsed value. Only the hex32 shape check can reject this (D4 bite proof).",
    [raMicrochip],
    [noPrefixObfuscated],
    raReserved,
    obfuscatedShapeRoot,
    false,
  );
}

if (redactedArtifacts.filter((v) => v.valid).length < 3) {
  throw new Error("gen: expected at least 3 positive redacted-artifact vectors");
}
if (redactedArtifacts.filter((v) => !v.valid).length < 3) {
  throw new Error("gen: expected at least 3 negative redacted-artifact vectors");
}

const out = {
  _comment:
    "Shared DogTag SDK test vectors (impl §9; inclusion proofs per DSDP plan §2.3). TS = reference; " +
    "dogtag-standard-rs + the iOS Swift verifier assert this file. " +
    "Leaf = Poseidon(DS_LEAF, fieldOf(keyPath), fieldOf(salt), fieldOf(typeTag), fieldOf(value)); " +
    "inclusion steps are root-ward {sibling:0x..}|{promote:true}; salts are fixed for reproducibility. " +
    "redactedArtifacts (WP4.10S) exercises verifyRedactedArtifact - masking a disclosed leaf into " +
    "obfuscatedLeafHashes never changes root, and the deliberately-invalid entries are equally " +
    "implementation-generated (self-checked against verifyRedactedArtifact before being written).",
  field_p: FIELD_P.toString(),
  leaves,
  bytesToField: btf,
  merkle,
  inclusion,
  redactedArtifacts,
};

const path = resolve(__dirname, "..", "testvectors.json");
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log(
  `wrote ${path}: ${leaves.length} leaf, ${btf.length} bytesToField, ${merkle.length} merkle, ` +
    `${inclusion.length} inclusion vectors (${inclusion.filter((v) => v.valid).length} valid, ` +
    `${inclusion.filter((v) => !v.valid).length} negative), ` +
    `${redactedArtifacts.length} redactedArtifacts (${redactedArtifacts.filter((v) => v.valid).length} valid, ` +
    `${redactedArtifacts.filter((v) => !v.valid).length} negative)`,
);
