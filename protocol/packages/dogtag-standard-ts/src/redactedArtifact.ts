// RedactedTagArtifact - selective disclosure BY OBFUSCATION over a device-built profile tree
// (WP4.10 plan section 2). OpenAttestation-style: a masked field survives only as its opaque leaf
// hash, and the Merkle root still recomputes exactly - "similar but not the same" as OA because
// nothing here ever depends on JSON.stringify. Every disclosed opening is the SAME canonically
// typed-scalar encoding every other leaf in this protocol uses (specs/leaf-commitment.md): masking
// a field only ever moves its opening out of the wire and keeps its leaf hash, it never changes how
// that hash - or the root - was computed in the first place.
//
// `verifyRedactedArtifact` is a COMPOSITION of the two frozen primitives every other verifier in
// this package is built from - `hashLeaf` (recompute a disclosed leaf from its opening) and
// `buildMerkle` (fold the full leaf set back to the root) - plus the same reserved-owner-namespace
// and duplicate-keyPath guards `verifyLeafCommitment` (profileBind.ts) already enforces. It adds no
// new hashing, encoding, or tree-construction rule of its own; `recomputeLeaf`/`sameMultiset` below
// are intentionally a second, independent transcription of profileBind.ts's private helpers of the
// same name (composed entirely from already-exported primitives: `hashLeaf`, `encodeValue`,
// `hexToBytes`, `scalarFromPacked`), not a shared import - profileBind.ts is frozen and untouched by
// this file, and any future drift between the two transcriptions is exactly what the equivalence
// test in redactedArtifact.test.ts (against every profile_bind.test.ts fixture) would catch.
//
// It is a STRICT GENERALIZATION of `verifyLeafCommitment` along two axes:
//
//   1. Some ordinary attribute leaves may be named ONLY by their opaque hash
//      (`obfuscatedLeafHashes`) instead of fully opened - `verifyLeafCommitment` has no such
//      concept; every non-reserved leaf it sees is fully opened. The 3 reserved leaves remain the
//      ALWAYS-opaque subset, exactly as before: `obfuscatedLeafHashes` and `reservedLeafHashes` are
//      both "an opaque hash this verifier folds in unopened", differing only in WHY. A reserved leaf
//      is opaque BY CONSTRUCTION - an outside verifier could never recompute it even in principle,
//      because its value is folded via `hash_reserved_leaf`'s raw-field slot rather than `hashLeaf`'s
//      ordinary length-prefixed one (specs/leaf-commitment.md section 9) - while an obfuscated leaf
//      is opaque BY CHOICE: the discloser held the real opening and withheld it.
//   2. The vet's bind-time identity cross-check (`expectedIdentityLeaves`, mandatory on
//      `verifyLeafCommitment`) becomes OPTIONAL (`opts.expectedIdentityLeaves`). Most consumers of a
//      redacted artifact - a third party checking a shared QR, say - hold no vet-attested KYC record
//      to check against and only care that the artifact recomputes its own root; a caller that DOES
//      hold such an oracle (the vet, or a relayer with a copy of its record) still gets the full
//      `verifyLeafCommitment` guarantee by supplying it.
//
// `redactedArtifact.test.ts` proves the generalization is exact on every existing
// `profile_bind.test.ts` fixture, translated into a `RedactedTagArtifact` with `obfuscatedLeafHashes:
// []`: `verifyRedactedArtifact(artifact, {expectedIdentityLeaves})` agrees with `verifyLeafCommitment`
// on every case, accept and reject alike - WITH ONE DOCUMENTED EXCEPTION outside that fixture set
// (specs/leaf-commitment.md section 15): a disclosed leaf whose recomputed hash equals a RESERVED
// hash is rejected here but accepted by `verifyLeafCommitment` (which has no overlap check at all),
// making this function strictly MORE conservative on that one axis, never more permissive - pinned by
// its own test in `redactedArtifact.test.ts` alongside the fixture-equivalence suite.
//
// NON-MASKABLE keyPaths: NONE, by evidence rather than assumption (WP4.10S item 1; see
// plans/orchestration/wp4.10S-progress.md's LOG for the full citation trail). The profile tree has
// no anchor ATTRIBUTE leaf: `credentialSubject.dogTagId` is a `WrappedDoc`/`verify.ts` concept (its
// `NON_OBFUSCATABLE`, checked against a flattened VC-style document's `data`) that never appears as a
// profile-tree leaf at all - `build_profile_tree` (profile_tree.rs) takes `dog_tag_id` as a bare
// KDF-binding scalar, never as an `AttributeLeaf`; the on-device fold that actually produces a real
// pet's attribute leaves (`ProfileAttributeFolding.foldPetAttributes`, dogtag-ios) never emits one
// either; and the frozen consent circuit says so directly (`circuits/consent.circom`: "dogTagId <->
// R is bound ON-CHAIN (profileRoot(dogTagId) == R), NOT in this circuit"). This artifact's identity
// anchor is instead the top-level `dogTagIdField` (mirrored by `dogTagIdDec`) - OUTSIDE the tree
// entirely, never a candidate for masking in the first place (masking only ever moves a LEAF's
// opening between `disclosed` and `obfuscatedLeafHashes`; envelope fields like `dogTagIdField` are
// not leaves and have no obfuscated form), and exactly what a caller already binds on-chain today
// (plan step 5: `profileRoot(dogTagIdField) == root`). The one thing that genuinely IS non-maskable
// is the RESERVED leaf triple's count and slot - already covered by check 1/3 below, not a keyPath
// rule at all: see `redactedArtifact.test.ts`'s "reserved leaf relabeled as obfuscated" test for why
// that count check is load-bearing on its own (the naive leaf multiset fed to `buildMerkle` is
// IDENTICAL whether a hash sits in `reservedLeafHashes` or `obfuscatedLeafHashes` - only the
// exactly-3 count/shape check tells the two apart).
import {hashLeaf, fieldOfKeyPath} from "./leaf.js";
import {encodeValue, hexToBytes, nfc} from "./encode.js";
import {buildMerkle} from "./merkle.js";
import {fromHex32, toHex32, type Field} from "./field.js";
import {scalarFromPacked} from "./wrap.js";
import {OWNER_IDENTITY_PREFIX, OWNER_NAMESPACE_PREFIX} from "./types.js";
import type {OpenedLeaf} from "./profileBind.js";

/**
 * The wire format (WP4.10 plan section 2): a `TagArtifact`-shaped custody record with some
 * attribute leaves opened (`disclosed`) and the rest named only by their opaque hash
 * (`obfuscatedLeafHashes`). A full, unredacted artifact is the DEGENERATE case of this same shape:
 * `obfuscatedLeafHashes: []`, `disclosed` holding every attribute leaf - so a plain `TagArtifact`
 * (rename `leaves` to `disclosed`, add an empty `obfuscatedLeafHashes`) already satisfies it.
 */
export interface RedactedTagArtifact {
  protocolVersion: string;
  /** The schema-registry `$id` this credential's record type was issued/received against. Not
   * consulted by this pure verifier (registry SHAPE and leaf-commitment ENCODING are independent
   * axes - specs/schemas/README.md); carried through for callers/registry validation. */
  schemaId?: string;
  dogTagIdDec?: string;
  /** The canonical on-chain dogTagId field (`dogTagIdField` in profileBind.ts) - the
   * `profileRoot(dogTagIdField) == root` binding key. OUTSIDE the tree: never a leaf, never
   * maskable, and not itself checked by this pure verifier (plan step 5 - a caller's on-chain job). */
  dogTagIdField: string;
  root: string;
  disclosed: OpenedLeaf[];
  obfuscatedLeafHashes: string[];
  reservedLeafHashes: string[];
  issuerClone: string;
}

export interface VerifyRedactedArtifactOpts {
  /** Optional identity cross-check oracle - when supplied, the `owner.identity.*` subset of
   * `disclosed` must equal this set exactly (vet-attested KYC cross-check), mirroring
   * `verifyLeafCommitment`'s mandatory `expectedIdentityLeaves`. Omitted by a verifier with no such
   * oracle (e.g. a third party checking only that the artifact recomputes its own root). */
  expectedIdentityLeaves?: OpenedLeaf[];
}

/** The total leaf count a redacted artifact may never exceed - the same frozen depth-6 consent-tree
 * capacity `profileBind.ts`'s `MAX_TOTAL_LEAVES` bounds-checks (3 reserved + up to 61 attribute
 * leaves, disclosed or obfuscated, in any split). */
const MAX_TOTAL_LEAVES = 64;
const RESERVED_LEAF_COUNT = 3;

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function isHex32(h: string): boolean {
  return HEX32.test(h);
}

/** Fix round 1 D2 (grade wp4.14S-grade.md): true if `saltHex` contains anything `hexToBytes` (frozen,
 * `encode.ts`) would silently MISHANDLE rather than reject. `hexToBytes` decodes byte-pair-by-byte-pair
 * via `parseInt(..., 16)`, which returns `NaN` for a non-hex pair - a `Uint8Array` store then coerces
 * that `NaN` to `0`, so a non-hex-but-even-length `saltHex` silently becomes a wrong-but-16-byte salt
 * instead of throwing. Rust's `hex::decode` (`redacted_artifact.rs`) errors on the identical input.
 * `hexToBytes`'s own odd-length check already throws correctly (matching Rust) and needs no help here;
 * this guard is checked anyway, defensively, so the combined condition matches `hex::decode`'s error
 * surface exactly. Deliberately a SECOND independent copy of `recordArtifact.ts`'s identically-named
 * helper (this file's own convention throughout - see its header on why `recomputeLeaf` itself is a
 * second transcription rather than a shared import). NOTE: `profileBind.ts`'s OWN private
 * `recomputeLeaf` (the bind-time tag-issuance path this file's `recomputeLeaf` mirrors) is FROZEN and
 * deliberately NOT given this guard - `profileBind.ts` is core hashing/encoding-adjacent verifier code
 * frozen since before WP4.10S introduced this file, out of scope for this wave entirely, and its own
 * divergence (if any) is unaffected by this fix. */
function isMalformedSaltHex(saltHex: string): boolean {
  const s = saltHex.startsWith("0x") ? saltHex.slice(2) : saltHex;
  return !/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0;
}

/** Recompute one disclosed leaf's hash from its posted opening. Throws on a malformed opening (bad
 * salt hex/length, unknown tag, bad value encoding) - `verifyRedactedArtifact` catches this and
 * rejects rather than propagate it, keeping the check fail-closed either way. Mirrors
 * `profileBind.ts`'s private `recomputeLeaf` - see the file header for why this is a deliberate
 * second transcription, not a shared import. As of fix round 1 D2, this transcription is no longer
 * BIT-IDENTICAL to `profileBind.ts`'s frozen original: it additionally guards `saltHex` before calling
 * `hexToBytes` (see `isMalformedSaltHex` above), a deliberate, disclosed cross-wave behavior change
 * this wave makes to a WP4.10S file - see plans/orchestration/wp4.14S-progress.md's deviations. */
function recomputeLeaf(leaf: OpenedLeaf): Field {
  if (isMalformedSaltHex(leaf.saltHex)) {
    throw new Error("saltHex contains a non-hex character or odd length (fix round 1 D2)");
  }
  const salt = hexToBytes(leaf.saltHex);
  const scalar = scalarFromPacked(leaf.tag, leaf.value);
  // encodeValue is called only to force a malformed value (e.g. a non-canonical integer) to throw
  // here rather than inside hashLeaf with a less specific stack, matching hashLeaf's own encoding.
  encodeValue(scalar);
  return hashLeaf(leaf.keyPath, salt, scalar);
}

/** Multiset equality over recomputed field hashes: same length, same values with the same
 * multiplicity, order irrelevant. Mirrors `profileBind.ts`'s private `sameMultiset`. */
function sameMultiset(a: Field[], b: Field[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const bs = [...b].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return as.every((v, i) => v === bs[i]);
}

/**
 * Verify a {@link RedactedTagArtifact}: does `root` really commit to exactly
 * `[3 reserved hashes] + [obfuscatedLeafHashes] + [disclosed]`, with every disclosed leaf hash
 * RECOMPUTED from its opening (never trusted), and does no disclosed leaf collide with an owner-
 * control keyPath, a duplicate keyPath, or an opaque (obfuscated/reserved) hash?
 *
 * Fail-closed by construction, exactly like `verifyLeafCommitment`: every check below can only turn
 * a `true` into `false`, and any exception thrown while parsing a malformed opening is caught and
 * treated as rejection, never propagated as an ambiguous crash. Checks, in order (plan section 2):
 *
 * 1. Exactly 3 reserved leaf hashes, all hex32-shaped; every obfuscated hash hex32-shaped; total
 *    leaf count (`reservedLeafHashes.length + disclosed.length + obfuscatedLeafHashes.length`) does
 *    not exceed 64; `root` hex32-shaped.
 * 2. No disclosed leaf names a reserved owner-control keyPath (`owner.*` outside `owner.identity.*`).
 *    No two disclosed leaves recompute to the same keyPath field (no duplicates). (No keyPath is
 *    required to be present - see the file header's non-maskable-set finding.)
 * 3. EVERY disclosed leaf hash is recomputed from its posted opening - a posted hash is never
 *    trusted, because there is none to trust: the wire shape carries openings, not hashes. A
 *    recomputed disclosed hash must never equal an obfuscated or reserved hash (overlap - mirrors
 *    `checkIntegrity`'s live-vs-obfuscated overlap check in verify.ts).
 * 4. The sorted, commutative Merkle root over `[3 reserved] + [obfuscated] + [N disclosed]` equals
 *    `root`.
 *
 * Step 5 of the plan (`profileRoot(dogTagIdField) == root`, `rootIssuer` resolution, `isValid` on
 * the issuer clone) is deliberately NOT this pure function's job - it needs chain reads and belongs
 * with the caller, exactly as `verify()`'s on-chain reads sit apart from `checkIntegrity` in verify.ts.
 *
 * The OPTIONAL `opts.expectedIdentityLeaves` cross-check, when supplied, additionally requires the
 * `owner.identity.*` subset of the recomputed disclosed leaves to equal it as an exact multiset - no
 * missing, extra, duplicate, or altered identity leaf, exactly like `verifyLeafCommitment`'s
 * (mandatory) version of the same check.
 */
export function verifyRedactedArtifact(artifact: RedactedTagArtifact, opts: VerifyRedactedArtifactOpts = {}): boolean {
  try {
    const {root, disclosed, obfuscatedLeafHashes, reservedLeafHashes} = artifact;

    if (reservedLeafHashes.length !== RESERVED_LEAF_COUNT) return false;
    if (!reservedLeafHashes.every(isHex32)) return false;
    if (!obfuscatedLeafHashes.every(isHex32)) return false;
    if (reservedLeafHashes.length + disclosed.length + obfuscatedLeafHashes.length > MAX_TOTAL_LEAVES) return false;
    if (!isHex32(root)) return false;

    const seenKeyPathFields = new Set<Field>();
    const disclosedHashes: Field[] = [];
    const identityHashes: Field[] = [];
    for (const leaf of disclosed) {
      const normalized = nfc(leaf.keyPath);
      if (normalized.startsWith(OWNER_NAMESPACE_PREFIX) && !normalized.startsWith(OWNER_IDENTITY_PREFIX)) {
        return false; // an owner-control keyPath posing as a disclosed attribute
      }
      const kpField = fieldOfKeyPath(leaf.keyPath);
      if (seenKeyPathFields.has(kpField)) return false; // duplicate disclosed keyPath
      seenKeyPathFields.add(kpField);

      const hash = recomputeLeaf(leaf);
      disclosedHashes.push(hash);
      if (normalized.startsWith(OWNER_IDENTITY_PREFIX)) identityHashes.push(hash);
    }

    if (opts.expectedIdentityLeaves !== undefined) {
      const expectedHashes = opts.expectedIdentityLeaves.map(recomputeLeaf);
      if (!sameMultiset(identityHashes, expectedHashes)) return false;
    }

    const reservedFields = reservedLeafHashes.map(fromHex32);
    const obfuscatedFields = obfuscatedLeafHashes.map(fromHex32);

    // overlap rejection: a disclosed leaf hash must never equal an obfuscated or reserved hash.
    const opaque = new Set<Field>([...reservedFields, ...obfuscatedFields]);
    for (const h of disclosedHashes) {
      if (opaque.has(h)) return false;
    }

    // RESERVED_LEAF_COUNT (3) is fixed and already checked above, so this list is never empty.
    const {root: computedRoot} = buildMerkle([...reservedFields, ...obfuscatedFields, ...disclosedHashes]);
    return toHex32(computedRoot) === root.toLowerCase();
  } catch {
    return false; // any parse failure on a malformed/hostile payload is a rejection
  }
}
