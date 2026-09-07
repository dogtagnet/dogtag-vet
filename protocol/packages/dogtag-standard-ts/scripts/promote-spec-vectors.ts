// Promote a named subset of packages/dogtag-standard-ts/testvectors.json's `redactedArtifacts`
// into the curated PUBLIC conformance file, specs/leaf-commitment-vectors.json's
// `redactedArtifactVectors` (specs/leaf-commitment.md section 15) - WP4.10S deferred item P1.
//
// WHY THIS EXISTS: testvectors.json's `redactedArtifacts` (populated by gen-testvectors.ts) carries
// 6 vectors, added in fix-round-1 commits b23f8db and bfd09a4, each constructed so the posted `root`
// is the GENUINE Merkle root of that vector's own exact leaf multiset - meaning only the ONE
// structural check it names can be the reason `verifyRedactedArtifact` rejects it, never an
// incidental root mismatch. Before this script, the curated public file's `redactedArtifactVectors`
// (the third-language conformance bar, section 13) carried none of these isolating negatives, so an
// outside implementer could delete the overlap check (or the duplicate-keyPath / 64-leaf-cap /
// hex32-shape checks) entirely and still reproduce every vector's `valid` outcome - see the (now
// removed) disclosed limitation this closed in section 15's worked examples.
//
// PROVENANCE DISCIPLINE (matches gen-testvectors.ts's own "self-checked before being written" rule,
// never hand-computed): every promoted vector's `disclosed[].expected_leaf_hex` is RECOMPUTED here
// via the real `hashLeaf`/`scalarFromPacked` (never copied from testvectors.json, which does not even
// carry that field); the root is independently RECOMPUTED via `buildMerkle` over the assembled
// {reserved, obfuscated, disclosed} multiset and asserted to equal the source vector's `root` before
// anything is written; and the assembled artifact is re-run through the real `verifyRedactedArtifact`
// and asserted to match the source vector's `valid` outcome. The only values carried forward verbatim
// are the already-opaque `obfuscatedLeafHashes`/`reservedLeafHashes` hex strings themselves (there is
// no opening to recompute them FROM - that is the point of obfuscation), and those are validated
// indirectly: if either were wrong, the independent root recomputation above would not match.
// `notes` is hand-authored fresh for a third-language reader (self-contained, no test-file names or
// internal WP/commit identifiers - section 13 promises this file is "self-contained JSON").
//
// This script NEVER modifies testvectors.json (the larger internal parity fixture stays exactly as
// gen-testvectors.ts left it) and is idempotent: re-running it replaces its own previously-promoted
// entries (matched by name) rather than duplicating them, and never touches the file's original 5
// hand-curated vectors (profile_tree_base_full_artifact and friends) or any other vectors-file
// section (leafHashVectors/merkleVectors/inclusionVectors/dogTagIdFieldVectors).
//
// Run via `pnpm promote-spec-vectors` after `pnpm gen-vectors` (or standalone - it only READS
// testvectors.json, never regenerates it).
import {readFileSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {TypeTag, hashLeaf, buildMerkle, toHex32, fromHex32, scalarFromPacked, verifyRedactedArtifact, type Field, type RedactedTagArtifact} from "../src/index.js";
import {hexToBytes} from "../src/encode.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SourceWireLeaf {
  keyPath: string;
  saltHex: string;
  tag: TypeTag;
  value: string;
}

interface SourceRedactedArtifactVec {
  name: string;
  notes: string;
  disclosed: SourceWireLeaf[];
  obfuscatedLeafHashes: string[];
  reservedLeafHashes: string[];
  root: string;
  valid: boolean;
}

interface CuratedWireLeaf extends SourceWireLeaf {
  tagName: string;
  expected_leaf_hex: string;
}

interface CuratedRedactedArtifactVec {
  name: string;
  notes: string;
  disclosed: CuratedWireLeaf[];
  obfuscatedLeafHashes: string[];
  reservedLeafHashes: string[];
  root_hex: string;
  valid: boolean;
}

// The exact 6 isolating negatives named in the grader's DEFERRED P1 note (ORCHESTRATION.md):
// the 2 overlap-half vectors (bfd09a4) plus the 4 D4 bite-proof vectors (b23f8db), each constructed
// so its `root` is the genuine root of its OWN exact multiset - never the other 9 vectors in
// testvectors.json's `redactedArtifacts` (those remain internal-only: full-coverage/parity fixtures
// this curated file was never meant to duplicate wholesale, per section 14's existing division of
// labor between the two files).
const PROMOTED_NAMES = [
  "negative_overlap_root_preserving_duplicate_leaf",
  "negative_overlap_reserved_half_matches_disclosed",
  "negative_duplicate_pet_keypath_no_identity_oracle",
  "negative_65_leaves_genuine_root_over_cap",
  "negative_hex32_shape_reserved_missing_0x_prefix",
  "negative_hex32_shape_obfuscated_missing_0x_prefix",
] as const;

// Hand-authored, self-contained notes for a third-language reader - deliberately NOT copied from
// testvectors.json (whose notes cite test filenames, "D2/D4", "the grade recipe", and the progress
// LOG: appropriate for this repo's own internal fixture, not for a spec file section 13 calls
// "self-contained JSON"). Each explains the construction, why `root` recomputes bit-for-bit despite
// it, and which single check is therefore the only one able to reject it.
const NOTES: Record<(typeof PROMOTED_NAMES)[number], string> = {
  negative_overlap_root_preserving_duplicate_leaf:
    "species's leaf hash is genuinely committed TWICE in this tree (the tree builder enforces keyPath uniqueness only for the 3 reserved leaves, never across ordinary attribute leaves, so two attribute leaves may legitimately fold to the same hash) - one copy is disclosed normally, the other copy's hash is separately listed in obfuscatedLeafHashes. root_hex is the genuine Merkle root over this exact 6-hash multiset (3 reserved + the duplicated species hash + microchip.code), so step 4's root comparison cannot tell this apart from a genuine artifact; only step 3's overlap check, on its obfuscated-half comparison, rejects it.",
  negative_overlap_reserved_half_matches_disclosed:
    "reservedLeafHashes[0] is deliberately set equal to the disclosed species leaf's own recomputed hash, rather than a genuine owner-control hash (unreachable from a real device tree without a Poseidon preimage - this exercises the verifier's behavior on the wire input directly, not a claim about what a real tree can produce). root_hex is the genuine root over this exact multiset, so only step 3's overlap check, on its reserved-half comparison, rejects it; step 1's exactly-3-reservedLeafHashes count check does not help, since there really are 3 entries.",
  negative_duplicate_pet_keypath_no_identity_oracle:
    "credentialSubject.name is disclosed TWICE, with different salts, and both openings genuinely fold into root_hex (a device tree has no rule against this for an ordinary attribute keyPath). No expectedIdentityLeaves oracle is supplied, which changes nothing here regardless: credentialSubject.name is not an owner.identity.* keyPath, so that optional cross-check was never going to see it. Since the root recomputes exactly over both openings, only step 2's duplicate-keyPath guard rejects this.",
  negative_65_leaves_genuine_root_over_cap:
    "65 total leaf hashes - 3 reserved plus 62 disclosed attribute leaves, one more than the 64-leaf cap (section 10) allows - carrying their own genuine Merkle root over that full multiset, so step 4's root comparison cannot reject it. Only step 1's total-leaf-count check (reservedLeafHashes.length + disclosed.length + obfuscatedLeafHashes.length <= 64) rejects this. The vector is necessarily large: 65 is the smallest leaf count that both exceeds the cap and still carries a self-consistent genuine root, so every one of the 62 attribute leaves has to be listed for root_hex to check out.",
  negative_hex32_shape_reserved_missing_0x_prefix:
    "reservedLeafHashes[0] is a genuine 64-hex-character field element with its \"0x\" prefix stripped. It decodes to the identical field element either way (the parser that folds it into the root treats the prefix as optional, stripping it when present), so root_hex is the same genuine root a fully-prefixed posting would produce. Only step 1's hex32-shape check, which requires the literal \"0x\" prefix, rejects this.",
  negative_hex32_shape_obfuscated_missing_0x_prefix:
    "obfuscatedLeafHashes[0] (species's hash) is a genuine 64-hex-character field element with its \"0x\" prefix stripped, decoding to the identical field element either way, so root_hex is the same genuine root a fully-prefixed posting would produce. Only step 1's hex32-shape check, which requires the literal \"0x\" prefix, rejects this.",
};

const TESTVECTORS_PATH = resolve(__dirname, "..", "testvectors.json");
const SPEC_VECTORS_PATH = resolve(__dirname, "..", "..", "..", "specs", "leaf-commitment-vectors.json");

const testvectors = JSON.parse(readFileSync(TESTVECTORS_PATH, "utf8")) as {
  redactedArtifacts: SourceRedactedArtifactVec[];
};
const specVectors = JSON.parse(readFileSync(SPEC_VECTORS_PATH, "utf8")) as {
  redactedArtifactVectors: CuratedRedactedArtifactVec[];
  [key: string]: unknown;
};

function recomputeLeafHash(l: SourceWireLeaf): Field {
  return hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalarFromPacked(l.tag, l.value));
}

function toCuratedLeaf(l: SourceWireLeaf): CuratedWireLeaf {
  return {
    keyPath: l.keyPath,
    saltHex: l.saltHex,
    tag: l.tag,
    tagName: TypeTag[l.tag]!,
    value: l.value,
    expected_leaf_hex: toHex32(recomputeLeafHash(l)),
  };
}

function promote(source: SourceRedactedArtifactVec): CuratedRedactedArtifactVec {
  const disclosedHashes = source.disclosed.map(recomputeLeafHash);
  const reservedFields = source.reservedLeafHashes.map(fromHex32);
  const obfuscatedFields = source.obfuscatedLeafHashes.map(fromHex32);
  const {root: recomputedRoot} = buildMerkle([...reservedFields, ...obfuscatedFields, ...disclosedHashes]);
  if (toHex32(recomputedRoot) !== source.root.toLowerCase()) {
    throw new Error(`promote: ${source.name}'s root does not recompute from its own disclosed+obfuscated+reserved multiset`);
  }

  const artifact: RedactedTagArtifact = {
    protocolVersion: "dogtag-v2/1",
    dogTagIdField: "1",
    issuerClone: "0x" + "11".repeat(20),
    root: source.root,
    disclosed: source.disclosed,
    obfuscatedLeafHashes: source.obfuscatedLeafHashes,
    reservedLeafHashes: source.reservedLeafHashes,
  };
  const got = verifyRedactedArtifact(artifact);
  if (got !== source.valid) {
    throw new Error(`promote: ${source.name} expected valid=${source.valid} but verifyRedactedArtifact returned ${got}`);
  }

  return {
    name: source.name,
    notes: NOTES[source.name as (typeof PROMOTED_NAMES)[number]],
    disclosed: source.disclosed.map(toCuratedLeaf),
    obfuscatedLeafHashes: source.obfuscatedLeafHashes,
    reservedLeafHashes: source.reservedLeafHashes,
    root_hex: source.root,
    valid: source.valid,
  };
}

const bySourceName = new Map(testvectors.redactedArtifacts.map((v) => [v.name, v]));
const promoted: CuratedRedactedArtifactVec[] = [];
for (const name of PROMOTED_NAMES) {
  const source = bySourceName.get(name);
  if (!source) throw new Error(`promote: ${name} not found in testvectors.json's redactedArtifacts`);
  promoted.push(promote(source));
}

// Idempotent: drop any prior copies of exactly these names (by name, not position) before
// re-appending, so re-running this script updates rather than duplicates, and the original 5
// hand-curated vectors (indices 0-4, referenced BY INDEX in specs/leaf-commitment.md section 15's
// earlier worked examples) keep their exact positions.
const promotedNameSet = new Set<string>(PROMOTED_NAMES);
specVectors.redactedArtifactVectors = specVectors.redactedArtifactVectors.filter((v) => !promotedNameSet.has(v.name));
specVectors.redactedArtifactVectors.push(...promoted);

// ------------------------------------------------------------------------------------------------
// WP4.14S - recordArtifactVectors (specs/leaf-commitment.md section 16): the RecordArtifact sibling
// of redactedArtifactVectors above, over a tree with NO reserved leaves. UNLIKE the promotion above,
// there is no pre-existing "recordArtifacts" fixture set in testvectors.json to promote FROM
// (gen-testvectors.ts is out of scope for this wave - plans/orchestration/wp4.14S-progress.md), so
// these six vectors are instead COMPUTED DIRECTLY here, via the same real hashLeaf/buildMerkle
// primitives every other section of this script and of leaf-commitment-vectors.json itself already
// uses - never hand-typed. They are proven correct against the real verifyRecordArtifact
// (packages/dogtag-standard-ts/src/recordArtifact.ts) by that function's own test suite
// (test/recordArtifact.test.ts), which loads this exact file and asserts every vector's `valid`
// outcome is reproduced - the identical division of labor leafHashVectors/merkleVectors/
// inclusionVectors/dogTagIdFieldVectors already have with spec_vectors.test.ts: none of those four
// sections are self-checked against a "verify" function inside their own generation either.
interface RecordLeaf {
  keyPath: string;
  saltHex: string;
  tag: TypeTag;
  value: string;
}

function recordLeafHash(l: RecordLeaf): Field {
  return hashLeaf(l.keyPath, hexToBytes(l.saltHex), scalarFromPacked(l.tag, l.value));
}

function toCuratedRecordLeaf(l: RecordLeaf) {
  return {
    keyPath: l.keyPath,
    saltHex: l.saltHex,
    tag: l.tag,
    tagName: TypeTag[l.tag]!,
    value: l.value,
    expected_leaf_hex: toHex32(recordLeafHash(l)),
  };
}

// The seven non-maskable leaves (specs/leaf-commitment.md section 16) every valid record artifact
// must disclose, plus two ordinary clinical (maskable) leaves used by the full/masked vectors below.
// Values mirror a realistic dogtag.vaccination.v1 record (specs/schemas/dogtag.vaccination.v1.schema.json).
const NM_DOG_TAG_ID: RecordLeaf = {keyPath: "credentialSubject.dogTagId", saltHex: "11".repeat(16), tag: TypeTag.String, value: "424242"};
const NM_RECORD_TYPE: RecordLeaf = {keyPath: "recordType", saltHex: "22".repeat(16), tag: TypeTag.String, value: "VACCINATION"};
const NM_SCHEMA_ID: RecordLeaf = {keyPath: "credentialSchema.id", saltHex: "33".repeat(16), tag: TypeTag.String, value: "https://dogtag.io/schemas/vaccination/v1"};
const NM_SCHEMA_VERSION: RecordLeaf = {keyPath: "credentialSchema.version", saltHex: "44".repeat(16), tag: TypeTag.String, value: "1.0.0"};
const NM_CHAIN_ID: RecordLeaf = {keyPath: "issuer.chainId", saltHex: "55".repeat(16), tag: TypeTag.Integer, value: "135"};
const NM_CONTRACT: RecordLeaf = {keyPath: "issuer.contract", saltHex: "66".repeat(16), tag: TypeTag.String, value: "0x86d9ac6c094783e6a27d3bdbb6ef868060256c75"};
const NM_OPERATOR: RecordLeaf = {keyPath: "issuer.operator", saltHex: "77".repeat(16), tag: TypeTag.String, value: "0x15759c525000000000000000000000000000cda"};
const NON_MASKABLE: RecordLeaf[] = [NM_DOG_TAG_ID, NM_RECORD_TYPE, NM_SCHEMA_ID, NM_SCHEMA_VERSION, NM_CHAIN_ID, NM_CONTRACT, NM_OPERATOR];

const CLINICAL_PRODUCT_NAME: RecordLeaf = {keyPath: "vaccineProductName", saltHex: "88".repeat(16), tag: TypeTag.String, value: "Rabvac 3"};
const CLINICAL_BATCH: RecordLeaf = {keyPath: "batchLotNumber", saltHex: "99".repeat(16), tag: TypeTag.String, value: "LOT-998"};

const fullLeaves: RecordLeaf[] = [...NON_MASKABLE, CLINICAL_PRODUCT_NAME, CLINICAL_BATCH];
const fullRootHex = toHex32(buildMerkle(fullLeaves.map(recordLeafHash)).root);

const recordFullArtifact = {
  name: "record_full_artifact",
  notes:
    "The seven non-maskable leaves (specs/leaf-commitment.md section 16) plus two ordinary clinical leaves (vaccineProductName, batchLotNumber), nothing masked: obfuscatedLeafHashes and reservedLeafHashes are both empty. This is the reference root the masked variants below must reproduce exactly.",
  disclosed: fullLeaves.map(toCuratedRecordLeaf),
  obfuscatedLeafHashes: [] as string[],
  reservedLeafHashes: [] as string[],
  root_hex: fullRootHex,
  valid: true,
};

const recordMaskedClinicalLeaf = {
  name: "record_masked_clinical_leaf",
  notes:
    "Masks batchLotNumber (a maskable clinical leaf, NOT in the non-maskable set) - moves its hash into obfuscatedLeafHashes and drops its opening from disclosed. Reproduces record_full_artifact's identical root: buildMerkle folds the same 9 leaf hashes either way, so which array names each one is invisible to the root.",
  disclosed: [...NON_MASKABLE, CLINICAL_PRODUCT_NAME].map(toCuratedRecordLeaf),
  obfuscatedLeafHashes: [toHex32(recordLeafHash(CLINICAL_BATCH))],
  reservedLeafHashes: [] as string[],
  root_hex: fullRootHex,
  valid: true,
};

const recordMaskedExceptNonMaskable = {
  name: "record_masked_except_non_maskable",
  notes:
    "Masks EVERY clinical leaf (vaccineProductName and batchLotNumber both moved to obfuscatedLeafHashes), disclosing only the seven non-maskable leaves - the falsifiable demonstration that the non-maskable set is real: masking down to exactly this set still verifies (unlike a RedactedTagArtifact, where the non-maskable set is empty and masking down to nothing at all still verifies - specs/leaf-commitment.md section 15). Reproduces record_full_artifact's identical root.",
  disclosed: NON_MASKABLE.map(toCuratedRecordLeaf),
  obfuscatedLeafHashes: [CLINICAL_PRODUCT_NAME, CLINICAL_BATCH].map((l) => toHex32(recordLeafHash(l))),
  reservedLeafHashes: [] as string[],
  root_hex: fullRootHex,
  valid: true,
};

const recordNegativeMaskedDogtagid = {
  name: "record_negative_masked_dogtagid",
  notes:
    "Moves credentialSubject.dogTagId's hash into obfuscatedLeafHashes instead of disclosed - the same 9-hash multiset as record_full_artifact, just repartitioned, so root_hex is bit-identical to it and step 4's root comparison alone cannot reject this. Only the non-maskable-set-must-be-disclosed check (specs/leaf-commitment.md section 16) rejects it, since dogTagId - one of the seven required keyPaths - is no longer found among disclosed's keyPaths.",
  disclosed: [NM_RECORD_TYPE, NM_SCHEMA_ID, NM_SCHEMA_VERSION, NM_CHAIN_ID, NM_CONTRACT, NM_OPERATOR, CLINICAL_PRODUCT_NAME, CLINICAL_BATCH].map(toCuratedRecordLeaf),
  obfuscatedLeafHashes: [toHex32(recordLeafHash(NM_DOG_TAG_ID))],
  reservedLeafHashes: [] as string[],
  root_hex: fullRootHex,
  valid: false,
};

// A single bogus hash, FOLDED INTO the posted root (unlike the non-isolating shape section 15's own
// "negative_overlap" worked example warns against), so the root comparison alone cannot reject this -
// only the reserved-must-be-empty check (specs/leaf-commitment.md section 16) can.
const BOGUS_RESERVED_HEX = "0x" + "0".repeat(63) + "1";
const reservedPresentRootHex = toHex32(buildMerkle([fromHex32(BOGUS_RESERVED_HEX), ...fullLeaves.map(recordLeafHash)]).root);
const recordNegativeReservedPresent = {
  name: "record_negative_reserved_present",
  notes:
    "Carries one entry in reservedLeafHashes (an arbitrary field element, not a genuine owner-control hash - a record artifact never has one to begin with) and FOLDS it into root_hex, so the posted root is the genuine root of this exact 10-hash multiset and the root comparison alone cannot reject it. Every other check passes (all seven non-maskable leaves are disclosed; no overlap). Only the reserved-must-be-empty check rejects this.",
  disclosed: fullLeaves.map(toCuratedRecordLeaf),
  obfuscatedLeafHashes: [] as string[],
  reservedLeafHashes: [BOGUS_RESERVED_HEX],
  root_hex: reservedPresentRootHex,
  valid: false,
};

// A genuinely duplicated clinical leaf hash - one copy disclosed normally, the other copy's hash
// separately listed in obfuscatedLeafHashes - with root_hex the genuine root of the multiset
// containing it TWICE (mirrors redactedArtifactVectors' negative_overlap_root_preserving_duplicate_leaf,
// not the non-isolating "negative_overlap" shape section 15's worked examples warn against).
const productNameHash = recordLeafHash(CLINICAL_PRODUCT_NAME);
const overlapRootHex = toHex32(buildMerkle([...NON_MASKABLE.map(recordLeafHash), productNameHash, productNameHash]).root);
const recordNegativeOverlap = {
  name: "record_negative_overlap",
  notes:
    "vaccineProductName's leaf hash is genuinely committed TWICE in this tree (a record tree, like a profile tree, enforces no cross-leaf uniqueness among ordinary attribute leaves) - one copy is disclosed normally, the other copy's hash is separately listed in obfuscatedLeafHashes. root_hex is the genuine Merkle root over this exact 9-hash multiset (7 non-maskable plus the duplicated vaccineProductName hash twice), so the root comparison cannot tell this apart from a genuine artifact; only the overlap check rejects it.",
  disclosed: [...NON_MASKABLE, CLINICAL_PRODUCT_NAME].map(toCuratedRecordLeaf),
  obfuscatedLeafHashes: [toHex32(productNameHash)],
  reservedLeafHashes: [] as string[],
  root_hex: overlapRootHex,
  valid: false,
};

specVectors.recordArtifactVectors = [
  recordFullArtifact,
  recordMaskedClinicalLeaf,
  recordMaskedExceptNonMaskable,
  recordNegativeMaskedDogtagid,
  recordNegativeReservedPresent,
  recordNegativeOverlap,
];

writeFileSync(SPEC_VECTORS_PATH, JSON.stringify(specVectors, null, 2) + "\n");
console.log(
  `wrote ${SPEC_VECTORS_PATH}: redactedArtifactVectors now has ${specVectors.redactedArtifactVectors.length} entries ` +
    `(${promoted.length} promoted from testvectors.json: ${promoted.map((v) => v.name).join(", ")}); ` +
    `recordArtifactVectors now has ${(specVectors.recordArtifactVectors as unknown[]).length} entries (computed directly)`,
);
