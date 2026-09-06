# DogTag leaf-commitment specification v1

Status: NORMATIVE.
This document is the single language-neutral reference an implementer needs to recompute a DogTag profile-tree root from stored custody data, or to build a new conformant implementation from scratch.
It describes the encoding, hashing, and tree construction that back every DogTag credential and every on-device consent profile tree.

Scope: this document covers the leaf-commitment primitive only - canonical encoding, keyPath addressing, Poseidon leaf/node hashing, Merkle tree construction, and inclusion proofs.
It does not cover the ZK consent circuit's internal wiring, the wrap/disclosure envelope formats, or the credential schema registry (see `specs/schemas/` for the latter).
Everything this document describes is CRYPTO-FROZEN: the reference implementation lives at `packages/dogtag-standard-ts/src` (TypeScript) and `crates/dogtag-standard-rs/src` (Rust), the two are byte-for-byte equivalent, and neither may change its hashing or encoding semantics without minting a new protocol version (section 12).
Non-normative pointers to the reference implementation appear throughout as `impl:` notes; they are an aid to readers of this repository, not part of the contract itself.

## 1. Terminology and the TypedScalar model

A DogTag credential, once prepared for commitment, is a tree of nested objects and arrays whose leaves are TYPED SCALARS.
A typed scalar is a `(tag, value)` pair: the tag names which of six kinds of value this is, and the value is the payload in that kind's canonical form.
This tagging exists so that `"5"` (the string) and `5` (the integer) commit to different leaves even though a naive JSON encoding of both looks similar - conflating them would let a prover substitute one for the other undetected.
A native floating-point number MUST NEVER reach the wrap boundary: every numeric value is either an INTEGER or a DECIMAL, always carried as a string, never as an IEEE-754 float.
This is a hard rule, not a style preference, because floats have multiple byte representations for the same mathematical value and this specification commits to exactly one canonical byte string per value.

### TypeTag table

| Tag | Numeric value | Value carried as | Canonical encoding (section 2) |
|---|---|---|---|
| Null | 0 | `null` | zero bytes |
| Bool | 1 | `boolean` | one byte: `0x01` (true) or `0x00` (false) |
| String | 2 | `string` | NFC-normalized UTF-8 bytes |
| Integer | 3 | decimal-digit string | canonical integer ASCII string |
| Decimal | 4 | fixed-point decimal string | canonical decimal ASCII string |
| Bytes | 5 | raw byte string | the bytes, unchanged |

`impl:` `packages/dogtag-standard-ts/src/types.ts` (`TypeTag`, `TypedScalar`), `crates/dogtag-standard-rs/src/types.rs`.

## 2. Canonical value encoding

`encodeValue(scalar)` maps a typed scalar to its canonical byte string.
This function is the single point every other rule in this document builds on: two typed scalars commit to the same leaf if and only if they carry the same tag and `encodeValue` produces the same bytes for both.

- Null encodes to the empty byte string.
- Bool encodes to exactly one byte, `0x01` for true or `0x00` for false.
- String is first NFC-normalized, then UTF-8 encoded.
  Unicode normalization is pinned to Unicode version 15.1 so that two implementations built against different ICU/unicode-normalization releases still agree; a runtime whose bundled Unicode tables predate 15.1 is not conformant.
  A string containing an unpaired UTF-16 surrogate is rejected outright rather than silently normalized, since an unpaired surrogate has no defined NFC form.
- Integer is first canonicalized, then ASCII-encoded.
  The canonical grammar is `-?(0|[1-9][0-9]*)`: no leading zeros, and the single exception `-0` canonicalizes to `0`.
  A string outside this grammar (a leading zero, a decimal point, whitespace, a leading `+`) is rejected, not coerced.
- Decimal is first canonicalized, then ASCII-encoded.
  The input grammar is `-?(0|[1-9][0-9]*)(\.[0-9]+)?`; canonicalization strips trailing fractional zeros, then drops a trailing bare `.` if stripping left one, then maps `-0` and `-0.0`-shaped results to `0`.
  `"22.70"` and `"22.7"` are therefore two different input strings that encode to the identical canonical bytes and hash to the identical leaf (worked example in section 6).
  An exponent form, whitespace, or a leading `+` is rejected.
- Bytes encodes to the raw byte string unchanged: no normalization, no length prefix at this layer (a length prefix is introduced later, inside `bytesToField`, section 5).

`impl:` `packages/dogtag-standard-ts/src/encode.ts` (`encodeValue`, `nfc`, `canonicalInteger`, `canonicalDecimal`, `assertNotFloat`), `crates/dogtag-standard-rs/src/encode.rs`.

## 3. keyPath grammar (flatten rule F2a)

A credential is walked depth-first from its root to produce a flat list of `(keyPath, scalar)` pairs.
The keyPath is a string address built from the walk, and it is itself hashed as part of the leaf (section 6), so its exact grammar is load-bearing: two different keyPath strings for logically-the-same field would commit to two different leaves.

Construction rules:

- The root has no leading separator: a top-level field `name` produces the keyPath `name`, not `.name`.
- An object key `k` nested under a path `p` produces the child path `p.k` (or bare `k` if `p` is the root).
  The key is NFC-normalized before being placed in the path, exactly as a String value would be, so two byte-distinct but NFC-equivalent key spellings address the same leaf.
- An array element at index `i` nested under a path `p` produces the child path `p[i]`.
  `i` is rendered in base-10 with no leading zeros: `[0]`, `[1]`, ... `[10]`, never `[00]`.
- The three characters `.`, `[`, `]` are RESERVED and may never appear inside an object key.
  A key containing one of them is rejected outright (`walk` throws), because allowing it would make keyPath tokenization ambiguous - a scanner could no longer tell a literal `.` inside a key apart from a path separator.
- An empty object (`{}`) or empty array (`[]`) at any position, including the document root, does not recurse further: it produces exactly one leaf at that position's own keyPath, with scalar `{tag: Null, value: null}`.
  This is the mechanism by which "this optional structure is entirely absent" becomes a single, hashable, provably-absent leaf rather than a structural hole a prover could fill in silently.

Grammar summary (informal, over the already-NFC-normalized key alphabet):

```
keyPath   := segment ("." segment | index)*
segment   := (any Unicode scalar value except "." "[" "]")+
index     := "[" digit+ "]"          ; no leading zero unless the index itself is 0
```

`impl:` `packages/dogtag-standard-ts/src/flatten.ts` (`flatten`, `walk`, `tokenizeKeyPath`), `crates/dogtag-standard-rs/src/flatten.rs`.

## 4. Packed wire form (flatten rule F2b)

When a leaf's opening is carried on the wire (inside a wrapped document's `data` field, in a selective-disclosure envelope, or in a stored custody artifact), it is packed into one string:

```
{saltHex}:{tag}:{value}
```

- `saltHex` is the leaf's 16-byte salt (section 4), lowercase hex, always exactly 32 characters.
- `tag` is the decimal ASCII rendering of the TypeTag's numeric value (`0` through `5`).
- `value` is the scalar's canonical STRING form: for Null the empty string, for Bool `"true"`/`"false"`, for String/Integer/Decimal the canonical string itself, and for Bytes the lowercase hex of the raw bytes (no `0x` prefix).

A parser MUST split on the first two `:` characters only, never on every `:` in the string.
This matters because `value` is free to contain colons: an ISO-8601 timestamp such as `2026-06-17T14:46:29Z` contains two, and a naive split-on-every-colon parser would shred it.
`packages/dogtag-standard-ts/testvectors.json`'s `leaves` vector named `"timestamp"` (already asserted by this repository's own test suite) is exactly this case: keyPath `vaccinationDate`, value `2026-06-17T14:46:29Z`, and the packed wire form still parses correctly because parsing stops after the second colon.

`impl:` `packages/dogtag-standard-ts/src/wrap.ts` (`parsePacked`, `scalarFromPacked`, F2b split-on-first-two-colons).

### Salt rules

- Every salt is exactly 16 bytes.
  `hashLeaf` rejects any other length outright.
- For an ordinary attribute leaf, the salt is fresh cryptographically-random bytes, generated by whichever device builds the tree (normally the owner's own device, via a `SaltProvider` backed by a CSPRNG).
- For the `owner.identity.*` leaves specifically (the vet-attested human-identity carve-out, section 9), the salt is instead ATTESTER-GENERATED: the issuing vet's own record supplies the salt for these particular openings, so that at bind time the vet can independently recompute and cross-check exactly these openings against its own attested record (`verifyLeafCommitment`'s `expectedIdentityLeaves` parameter).
  This is a provenance POLICY layered on top of the hashing primitive, not a change to it: `hashLeaf` treats a salt identically no matter who generated it, and nothing about the leaf's byte layout reveals its salt's origin.

## 5. Field encoding

Every hash in this specification is a Poseidon hash over the BN254 scalar field, `F_p` where:

```
p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
```

A field element's canonical wire serialization is 32-byte big-endian hex, `0x`-prefixed (`toHex32` / `fromHex32`).
All arithmetic (comparisons, sorting) treats a field element as the non-negative integer it big-endian-decodes to.

Four domain-separation constants exist, each used only as the FIRST input slot of a Poseidon call, never as a running accumulator's initial value in a way that could be confused with real data:

| Constant | Value | Used by |
|---|---|---|
| `DS_LEAF` | 1 | `hashLeaf` (section 6) |
| `DS_NODE` | 2 | `hashNode` (section 7) |
| `DS_BYTES` | 3 | `bytesToField` (below) |
| `DS_NULLIFIER` | 4 | the consent nullifier scheme - out of scope for this document |

Two byte-to-field packing functions are used, and they are NOT interchangeable:

- `fieldFromScalarBytes(bytes)` packs up to 31 bytes DIRECTLY into one field element via a plain big-endian decode.
  It is used for fixed-size scalars that already fit in one field element with no ambiguity: a 16-byte salt, a 20-byte address.
  It never folds and it applies no domain separation of its own - it is a bare re-interpretation of bytes as an integer.
- `bytesToField(bytes)` folds an ARBITRARY-LENGTH byte string into one field element via a length-prefixed, domain-separated, chunked Poseidon2 chain.
  It is used for variable-length components: a keyPath string, an encoded value.
  The algorithm: prepend an 8-byte big-endian length prefix to the input, then process the result in consecutive 31-byte chunks (the last chunk right-zero-padded to 31 bytes if short), folding each chunk into a running accumulator that starts at `DS_BYTES` via `acc := Poseidon2(acc, beBigInt(chunk))`.
  Each 31-byte limb decodes to a value strictly less than `2^248 < p`, so the big-endian decode of every chunk is injective - no chunk can wrap around the field and collide with a different chunk.
  The 8-byte length prefix means the empty byte string still produces at least one non-trivial chunk (the prefix itself), so `bytesToField("")` is never equal to the bare constant `DS_BYTES`.
  As a concrete, already-asserted illustration: `bytesToField` of the empty byte string yields `0x3043ce8ad378d029838ba8eef2e18e68d25ec1e09586fa39b30bf83fd19832c3` (`packages/dogtag-standard-ts/testvectors.json`, `bytesToField`/`"empty"`).

`fieldFromUint(n)` reduces a small non-negative integer (a TypeTag number, an array index) into `F_p` by plain modular reduction; every value this specification actually uses it for is already far smaller than `p`, so the reduction is a no-op in practice and exists only to fix the type.

`impl:` `packages/dogtag-standard-ts/src/field.ts` (`FIELD_P`, `DS_LEAF`/`DS_NODE`/`DS_BYTES`/`DS_NULLIFIER`, `poseidon`, `bytesToField`, `fieldFromScalarBytes`, `fieldFromUint`, `toHex32`/`fromHex32`), `crates/dogtag-standard-rs/src/field.rs` + `poseidon.rs`.

## 6. Leaf hashing (`hashLeaf`)

A leaf's hash commits to four things: its keyPath, its salt, its TypeTag, and its canonical value.
It is a single fixed-arity, five-input Poseidon call (Poseidon5, sometimes written `t=6` for its five inputs plus the capacity element):

```
hashLeaf(keyPath, salt, scalar) =
  Poseidon5(
    DS_LEAF,
    bytesToField(utf8(nfc(keyPath))),
    fieldFromScalarBytes(salt),
    fieldFromUint(scalar.tag),
    bytesToField(encodeValue(scalar)),
  )
```

keyPath and the encoded value both go through the folding `bytesToField` (they are variable-length); the 16-byte salt goes through the direct, non-folding `fieldFromScalarBytes` (it is fixed-size); the TypeTag goes through `fieldFromUint` (it is a small integer, not a byte string).

### Worked example

Leaf: keyPath `credentialSubject.name`, salt `0x33333333333333333333333333333333` (16 bytes of `0x33`), TypeTag `String` (2), value `"Rex"`.

1. `fieldOfKeyPath` = `bytesToField(utf8("credentialSubject.name"))`.
2. `fieldFromScalarBytes(salt)` = the salt's 16 bytes, big-endian, as one field element.
3. `fieldFromUint(2)` = `2`.
4. `fieldOfValue` = `bytesToField(utf8("Rex"))` (String's canonical encoding is its NFC UTF-8 bytes; `"Rex"` has no combining characters, so NFC is a no-op here).
5. `hashLeaf(...)` = `Poseidon5(1, step1, step2, 2, step4)` = `0x274e7725d924cad641568371de49ac31d34cf7999e94248c60dd27f4fc1f6eb7`.

This exact tuple is `leafHashVectors[2]` (`"string_leaf"`) in `specs/leaf-commitment-vectors.json` (section 14).

### NFC and canonical-decimal collisions are the point, not a bug

Two further vectors in that same file make concrete why NFC-pinning and decimal canonicalization exist:

- `"string_nfc_leaf"` hashes the value `José` written as one precomposed code point (`U+00E9`), and `"nfc_alias_leaf"` hashes the SAME keyPath and salt with `José` written as a decomposed pair (`e` + combining acute, `U+0065 U+0301`).
  Both are byte-distinct inputs; both hash to the identical leaf, `0x097ec13d0ca08d7481ad94b6b2b51145b15595fcc2d52d78f6ffaa0efd537b4d`, because `nfc()` runs before hashing.
- `"decimal_leaf"` hashes the value `"22.70"` and `"decimal_leaf_canonical_form_check"` hashes `"22.7"` at the same keyPath and salt.
  Both hash to the identical leaf, `0x1b3bbcebf7d970735f715cdc8ed230e02633b3d43d3bffc693a60efac34c4691`, because `canonicalDecimal()` strips the trailing fractional zero before hashing.

An implementation that hashes the raw un-normalized string instead of the canonical form will silently disagree with every other conformant implementation on these two cases while agreeing on every simpler one - this is precisely the class of bug this specification's conformance vectors (section 14) exist to catch.

`impl:` `packages/dogtag-standard-ts/src/leaf.ts` (`hashLeaf`, `fieldOfKeyPath`, `fieldOfValue`), `crates/dogtag-standard-rs/src/leaf.rs`.

## 7. Node hashing and tree construction (`hashNode`, `buildMerkle`)

An internal node commits to an unordered pair of child hashes via a three-input Poseidon call (Poseidon3):

```
hashNode(a, b) = Poseidon3(DS_NODE, min(a, b), max(a, b))
```

`min`/`max` compare `a` and `b` as the non-negative integers they decode to.
This makes `hashNode` COMMUTATIVE: `hashNode(a, b) == hashNode(b, a)` always, by construction, not by convention.
Combined with the leaf-arity/node-arity split (Poseidon5 versus Poseidon3, section 8), commutativity is what lets `buildMerkle` sort leaves before folding without weakening the tree: swapping two children never changes their parent's hash, so there is no ordering information for an attacker to forge.

`buildMerkle` builds a tree bottom-up from an unordered list of leaf hashes:

1. Sort the leaf hashes ascending as integers.
   This is why the previous paragraph's commutativity matters: sorting is only sound to do post-hoc, without re-deriving anything, because pair order never affected the hash to begin with.
2. Pair the current level's list consecutively: `(0,1)`, `(2,3)`, ....
   If the list has an odd length, the LAST element (at the leaf level this is the numerically largest leaf hash, because that level and only that level is sorted; at higher levels it is simply the last element of the level) has no partner; it is PROMOTED unchanged to the next level rather than duplicated or padded.
3. Replace each pair with `hashNode(pair)` and each promoted singleton with itself, forming the next level.
4. Repeat steps 2 and 3 on the new level, WITHOUT re-sorting it, until exactly one hash remains: the ROOT.
   Only the leaf level is ever sorted; every level above it keeps the order the fold produced, and re-sorting an internal level would produce a different root.

A single-leaf tree needs zero rounds of folding: its root IS that one leaf's hash, unchanged.
There is no minimum or fixed leaf count in this primitive; a tree of any positive size is well-formed.
(A CONSUMER of this primitive, the consent-bind path, layers a maximum of 64 leaves on top for reasons unrelated to `buildMerkle` itself - see section 10.)

### Worked example: an odd-count tree with promotion

Three leaves, a small pet-profile fragment:

| keyPath | value | leaf hash |
|---|---|---|
| `credentialSubject.name` | `"Rex"` | `0x0760e0486c4c08cce2a5fa6e07dce2a86b89e12c24681186a0b67b3c4a44c977` |
| `credentialSubject.species` | `"dog"` | `0x1e2a8b2327908e91408416c14f99554c373d9ebad6571754b82cf319f676953d` |
| `credentialSubject.microchip.code` | `"985141006580319"` | `0x09fb163b818c8482976dcc3a149eb2336da14662a67c88aee86111f6aa254ec8` |

Sorted ascending, the `name` leaf is smallest and the `species` leaf is largest.
`buildMerkle` pairs the two smallest (`name`, `microchip.code`) into one node hash, and PROMOTES the remaining largest leaf (`species`) unchanged to the next level, where it is paired against that node hash to form the root:

```
root = hashNode( hashNode(name_leaf, microchip.code_leaf), species_leaf )
     = 0x0aab4b016bf14b1f08ec9542fa10a675c02f6ce6879470b226b12f25d643c624
```

The intermediate node hash `hashNode(name_leaf, microchip.code_leaf)` is `0x0d8cafa1138c3cedacc45fddd512991adaec2966265b340acd8c2cdbd55342e5`.
This exact tree, with every opening, every intermediate leaf hash, and the root, is `merkleVectors[0]` (`"size_3_pet_profile_promotion"`) in `specs/leaf-commitment-vectors.json`.

`impl:` `packages/dogtag-standard-ts/src/merkle.ts` (`hashNode`, `buildMerkle`), `crates/dogtag-standard-rs/src/merkle.rs`.

## 8. Inclusion proofs and `verifyInclusion`

An inclusion proof for a leaf is an ordered, root-ward list of steps, one per tree level, using exactly two step shapes:

- `{sibling: h}` - at this level the node was paired with sibling hash `h` (folded via the commutative `hashNode`).
- `{promote: true}` - at this level the node was the lone unpaired node and passed through unchanged.

This `Sibling | Promote` shape is DELIBERATELY more explicit than a bare list of sibling hashes: a promote step carries no hash, but its presence in the list still tells a verifier the tree's exact shape and depth at that point, which a silently-omitted step could not.
`inclusionVectors[2]` (`"size_3_pet_profile_leaf2_species_promote_inclusion"`) in `specs/leaf-commitment-vectors.json` is a real proof containing a `{promote}` step, over the same three-leaf tree used in the worked examples below.

`verifyInclusion(keyPath, salt, scalar, steps, root)` is the one normative way to check a disclosed leaf against an anchored root:

1. RECOMPUTE the leaf hash from the four disclosed components via `hashLeaf` - never trust a caller-supplied leaf hash, because a hash a verifier did not derive itself proves nothing about the opening it claims to summarize.
2. Fold that leaf hash root-ward through `steps`: for a `{sibling}` step, replace the running value with `hashNode(running, sibling)`; for a `{promote}` step, leave the running value unchanged.
3. The leaf is included if and only if the final folded value equals `root` exactly.

### Why this is sound

A leaf hash is a Poseidon5 image under `DS_LEAF = 1`.
An internal node hash is a Poseidon3 image under `DS_NODE = 2`.
These are different arities under different domain tags, so no value can simultaneously be read as both a valid leaf and a valid internal node - the two spaces do not overlap except by a Poseidon preimage or collision, which is computationally infeasible.
Consequently:

- An attacker cannot pass an internal node off as a disclosed leaf: doing so would require finding `(keyPath, salt, tag, value)` whose `hashLeaf` output equals that internal node's value, i.e. a Poseidon preimage.
- An attacker cannot forge inclusion for a value that was never actually committed: folding a non-member hash to the real root would require a Poseidon collision or preimage at some step of the fold.
- `{promote}` steps carry no cryptographic weight of their own (they do not feed into a hash); they exist purely to communicate tree shape, and tampering with one either breaks the fold arithmetic (wrong resulting value) or is simply a false claim about shape that step 3's final equality check catches regardless.

### Worked example, including a negative case

Continuing the three-leaf tree from section 7: `credentialSubject.name` sits at the leaf level's index 0, so its proof has one step per level, both of them `{sibling}` steps.
The actual proof (`inclusionVectors[0]` / `"size_3_pet_profile_leaf0_inclusion"` in `specs/leaf-commitment-vectors.json`) is:

```
steps = [
  {sibling: 0x09fb163b818c8482976dcc3a149eb2336da14662a67c88aee86111f6aa254ec8},  // microchip.code leaf
  {sibling: 0x1e2a8b2327908e91408416c14f99554c373d9ebad6571754b82cf319f676953d},  // species leaf
]
```

Recomputing `hashLeaf("credentialSubject.name", salt, {String, "Rex"})`, folding it against the first sibling, then the second, reaches `0x0aab4b016bf14b1f08ec9542fa10a675c02f6ce6879470b226b12f25d643c624` - the tree's root, so `verifyInclusion` returns `true`.
`inclusionVectors[1]` (`"size_3_pet_profile_leaf0_tampered_value"`) is the identical proof and root with the disclosed value changed to `"Max"`: recomputing the leaf now yields a different hash, the fold reaches a different final value, and `verifyInclusion` correctly returns `false`.

`impl:` `packages/dogtag-standard-ts/src/merkle.ts` (`ProofStep`, `merkleProof`, `processProof`, `verifyInclusion`), `crates/dogtag-standard-rs/src/merkle.rs`.

## 9. The reserved owner namespace and the three reserved leaves

The keyPath prefix `owner.` is RESERVED for owner-control leaves, current and future.
No caller-supplied attribute may name a keyPath inside this namespace, with exactly one carve-out: `owner.identity.*`, which is where vet-attested human-identity attributes (the pet owner's own name, address-of-record, and similar) live.
The carve-out exists because those fields need to behave like ordinary disclosable attribute leaves (hashed the standard way, individually provable, cross-checked against the issuing vet's record per section 4's salt-provenance rule) while still being visibly namespaced as identity data.

Outside that carve-out, exactly THREE reserved leaves exist per profile tree:

| keyPath | Carries |
|---|---|
| `owner.address` | the owner's on-chain wallet address |
| `owner.consentKey` | a hash of the owner's per-tag BabyJubJub consent public key |
| `owner.secret` | the owner's per-tag nullifier secret |

These three are never disclosed and never leave the owning device; a vet or any other external verifier receives them only as three opaque 32-byte hashes and MUST treat them as such.

### Reserved leaves hash differently from ordinary attribute leaves

The three reserved leaves use the same five-input `Poseidon5` / `DS_LEAF = 1` shape as an ordinary leaf, with two differences that matter:

1. Their TypeTag is always fixed at `Bytes` (5), regardless of what the underlying value conceptually is.
2. Their VALUE is written into the hash RAW - as a field element the on-device tree builder already has in hand (the owner's address bytes, the consent-key hash, the derived secret) - rather than being routed through `bytesToField`'s length-prefixed fold the way an ordinary leaf's value always is.

```
hash_reserved_leaf(keyPath, salt, valueField) =
  Poseidon5(DS_LEAF, bytesToField(utf8(nfc(keyPath))), fieldFromScalarBytes(salt), fieldFromUint(5), valueField)
```

This is why an external verifier - a vet platform, a relayer, any party that is not the owning device - can never recompute these three hashes from first principles, even in principle: it would need not only the owner's secret material (which never leaves the device by design) but also to know that the value slot is unfolded, a fact that is not inferable from the hash alone.
The correct and only normative treatment of the three reserved leaves, from outside the owning device, is to accept them as opaque 32-byte values, bounds-check their count (exactly three, section 10), reject any caller-supplied attribute that collides with their reserved keyPaths, and fold them into `buildMerkle` exactly like any other leaf hash.
Their construction (including the on-device key-derivation scheme that produces the salts and secret values) is out of scope for this document; see `crates/dogtag-standard-rs/src/profile_tree.rs` for the on-device reference.

### Rejection rule

Any caller-supplied attribute whose keyPath falls inside `owner.` but outside `owner.identity.` is rejected, checked two ways: first, a prefix match on the NFC-normalized keyPath string (catching every NFC-alias spelling of a reserved name); second, a field-level equality check comparing `fieldOfKeyPath(candidate)` against `fieldOfKeyPath` of each of the three pinned reserved keyPaths (a belt-and-suspenders check against the exact values the tree-building and verification code itself pins, independent of the string-level guard).
The on-device tree builder (`crates/dogtag-standard-rs/src/profile_tree.rs::build_profile_tree`) applies both checks; the server-side verifiers (`profileBind.ts`, `disclosure.ts`) apply the prefix guard alone, which is sufficient because both sides NFC-normalize before comparing, so the prefix guard already covers every alias of a reserved name.
The field-level check is a belt-and-suspenders drift guard against the exact values the consent circuit pins, not an independent security boundary.

`impl:` `packages/dogtag-standard-ts/src/types.ts` (`OWNER_NAMESPACE_PREFIX`, `OWNER_IDENTITY_PREFIX`), `profileBind.ts` and `disclosure.ts` (the rejection rule, twice, once per surface that polices this boundary), `crates/dogtag-standard-rs/src/profile_tree.rs` (`hash_reserved_leaf`, `KP_OWNER_ADDRESS`/`KP_CONSENT_KEY`/`KP_OWNER_SECRET`, `RESERVED_KEY_PATH_FIELDS`, `RESERVED_TYPE_TAG`).

## 10. The consent-tree 64-leaf cap, and why it does not apply to this primitive in general

The CONSENT-BIND path (the tree an owner's device builds to back a ZK consent proof) caps its total leaf count at 64: the three reserved leaves plus at most 61 opened attribute leaves.
This cap is enforced identically by the on-device tree builder and by every server-side verifier that checks a posted bind payload.

The reason is the frozen consent circuit, not this document's tree primitive.
`circuits/consent.circom` instantiates `DogTagConsent(depth)` at `depth = 6` (`component main = DogTagConsent(6)`), and that circuit's three reserved-leaf inclusion checks each take a FIXED-length, `depth`-element sibling array as a circuit input - a Groth16 circuit's witness shape is fixed at compile time, so the number of Merkle levels the circuit can verify is fixed too.
A depth-6 tree holds at most `2^6 = 64` leaves, hence the cap: `64 - 3 reserved = 61` attribute leaves is the most a consent-bindable tree can carry.

This is a POLICY the consent-bind path layers on top of `buildMerkle`/`verifyInclusion`, not a property of those functions.
The general primitive described in sections 7 and 8 accepts a tree of any positive leaf count, with no padding and no fixed depth; it is used for exactly this unbounded purpose elsewhere (a wrapped document's own root, section 7's worked example, and any future tree that never needs to be proven inside `DogTagConsent`).
This document does not describe how the fixed-depth circuit's witness accommodates a real tree shallower than depth 6; that is circuit-internal wiring, it is frozen, and it is out of scope here.

`impl:` `packages/dogtag-standard-ts/src/profileBind.ts` (`MAX_TOTAL_LEAVES = 64`, `RESERVED_LEAF_COUNT = 3`), `crates/dogtag-standard-rs/src/profile_tree.rs` (`CONSENT_TREE_DEPTH = 6`, `MAX_PROFILE_ATTRIBUTES = 61`), `circuits/consent.circom` (`DogTagConsent(depth)`, `component main = DogTagConsent(6)`).

## 11. `dogTagIdField` derivation

A DogTag's on-chain identity is minted as a decimal handle (a `uint256` an operator can type into a mint form), but every cryptographic use of that identity - the key `DogTagSBTConsent.profileRoot` is stored under, the consent circuit's first public signal - uses instead its CANONICAL FIELD FORM:

```
dogTagIdField(handleDec) = bytesToField(encodeValue({tag: Integer, value: handleDec}))
```

That is: treat the decimal handle string as an Integer-tagged scalar (so it goes through the same leading-zero/`-0` canonicalization as any other Integer value), UTF-8 encode its canonical form, and fold the result through `bytesToField`.
Note what this is NOT: it is not a `hashLeaf` call - there is no keyPath, no salt, and no domain-separation tag involved, only the bare `bytesToField` fold of the encoded integer.

### Worked example

`dogTagIdField("424242")` = `19282080935305080861096842252900215298393603684181619512414474199363734335896` (decimal) = `0x2aa145640869b118466a6f897b37241ea667694826ac38a8ce7bdcba5ad1f198` (hex).
This is `dogTagIdFieldVectors[0]` in `specs/leaf-commitment-vectors.json`, and it independently reproduces the pre-existing TS/Rust parity fixture already asserted in `packages/dogtag-standard-ts/test/profile_bind.test.ts`.

`impl:` `packages/dogtag-standard-ts/src/profileBind.ts` (`dogTagIdField`), `crates/dogtag-standard-rs/src/bin/field-hash.rs` (the Rust fixture generator this parity-pins against).

## 12. Protocol version identifiers - three strings, three purposes

Three distinct version strings appear across this protocol's surface.
They are NOT interchangeable, they do not evolve together, and conflating them is a category error this section exists to foreclose.

| String | Names | Lives at |
|---|---|---|
| `dogtag/1.0` | the WRAPPED-DOCUMENT ENVELOPE format (`WrappedDoc.version`) - the shape of `{version, data, signature, privacy, issuer, protocol?}` itself | `packages/dogtag-standard-ts/src/types.ts`, stamped by `wrap.ts`'s `wrapDocument` |
| `dogtag-levelb/1` (and siblings in that family) | the `ProtocolMeta.version` internal key inside the M7 record-provenance block - which protocol/contract build produced a given record, carried BESIDE `signature.merkleRoot`, never inside the hashed data | `packages/dogtag-standard-ts/src/types.ts` (`ProtocolMeta`), `crates/dogtag-standard-rs/src/discovery.rs` |
| `dogtag-v2/1` | THIS document's exact fixed encoding-and-hashing manner - the on-chain `ProtocolRegistry` discovery-set key that names "canonical encoding + Poseidon leaf/node hashing + the tree construction described in sections 1-11, as one fixed bundle" | `contracts/script/ProtocolVersions.sol` (`V2_VERSION`), read via `ProtocolRegistry` |

`dogtag-v2/1` is the identifier this specification's normative content is versioned under.
It names one exact, fixed way of turning a credential into a root: this exact `TypeTag` set, this exact canonical encoding, this exact keyPath grammar, this exact `hashLeaf`/`hashNode`/`buildMerkle` construction.
A future change to ANY of those - a new TypeTag, a different canonicalization rule, a different Poseidon arity or domain tag - is a DIFFERENT protocol version, published under a new string, never a silent revision of `dogtag-v2/1` itself.
Every artifact ever committed under `dogtag-v2/1` remains verifiable forever under this document's rules; a new version changes what NEW artifacts commit to, and never retroactively reinterprets an old one.

As of this writing, `dogtag-v2/1` is defined and published at the on-chain discovery layer (`ProtocolRegistry`, via `contracts/script/ProtocolVersions.sol`), but no source constant of that exact name yet exists inside `packages/dogtag-standard-ts/src` or `crates/dogtag-standard-rs/src` - the two standard-library implementations do not currently export a `V2_VERSION`-equivalent binding, despite the on-chain script's own comment describing `dogtag-v2/1` as "the same string `dogtag_standard::V2_VERSION`".
This document's normative content is unaffected either way (the hashing and encoding rules exist and are frozen regardless of which source file names them), but a future wave wiring `dogtag-v2/1` into the standard-library packages themselves should close this naming gap rather than leave the identifier defined only in Solidity.

## 13. Conformance

An implementation, in any language, is CONFORMANT with this specification if and only if it reproduces every vector in `specs/leaf-commitment-vectors.json` exactly - bit-for-bit field-element equality on every `expected_hex`/`expected_dec`/`root_hex`/`levels` value, and the correct `true`/`false` outcome on every `inclusionVectors` entry, including the deliberately-invalid ones.
The same `true`/`false` discipline applies to `redactedArtifactVectors` (section 15): reproducing every vector's `valid` outcome, the negative entries included, is part of conformance exactly as it is for `inclusionVectors`.
Where a `merkleVectors` entry carries a `levels` field (every intermediate fold level, not just the root), matching it exactly, in order, is part of reproducing that vector: it is what tells an implementer WHERE their fold diverges, not merely THAT it does.
Reproducing every POSITIVE vector but missing a negative one (for example, accepting `size_3_pet_profile_leaf0_tampered_value` as valid) is non-conformant: a leaf-commitment implementation that cannot detect tampering is not a correct implementation of `verifyInclusion`, regardless of how many roots it computes correctly.

This repository's own TS (`packages/dogtag-standard-ts`) and Rust (`crates/dogtag-standard-rs`) implementations are held to this same bar by `packages/dogtag-standard-ts/test/spec_vectors.test.ts` (section 14), which loads `specs/leaf-commitment-vectors.json` and asserts the TS implementation reproduces every entry.
A third-language implementation has no dependency on either existing codebase: the vectors file is self-contained JSON, and reproducing it is sufficient proof of conformance on its own.
As of WP4.10S fix round 1, `redactedArtifactVectors` isolates seven of `verifyRedactedArtifact`'s structural rejection paths one at a time: the exactly-3-reserved-hashes count check (`negative_reserved_relabeled_as_obfuscated`), the overlap check's obfuscated-half and reserved-half comparisons, the duplicate-keyPath guard, the 64-leaf cap, and both hex32-shape checks (reserved and obfuscated).
Each such vector's `root`/`root_hex` is the genuine Merkle root of that vector's own exact leaf multiset, so the named check is the ONLY one able to reject it - a conformant implementation cannot silently omit any one of those seven checks and still reproduce that vector's `valid: false` outcome.
See section 15's worked examples for exactly which vector isolates which check.
The same `true`/`false` discipline applies equally to `recordArtifactVectors` (section 16, added WP4.14S): reproducing every vector's `valid` outcome, negatives included, is part of conformance for `verifyRecordArtifact` exactly as it is for `verifyRedactedArtifact`, and every negative in that set is likewise constructed so its posted root is the genuine root of its own exact leaf multiset - the non-maskable-set check, the reserved-must-be-empty check, and the overlap check are each the ONLY reason their respective vector is rejected, never an incidental root mismatch.

## 14. Test vectors

`specs/leaf-commitment-vectors.json` is the vectors file this specification's conformance clause (section 13) refers to.
Every value in it was produced by calling the existing `packages/dogtag-standard-ts` implementation directly (never hand-computed), and it is re-verified by `packages/dogtag-standard-ts/test/spec_vectors.test.ts` on every test run.
Its six top-level sections:

- `leafHashVectors` - one `hashLeaf` vector per `TypeTag` (Null, Bool, String, Integer, Decimal, Bytes), plus the NFC-alias pair and the decimal-canonicalization pair discussed in section 6.
- `merkleVectors` - the odd-count, promotion-exercising three-leaf tree from section 7's worked example (`size_3_pet_profile_promotion`), carrying every opening, every leaf hash, and the root; plus a five-leaf tree (`size_5_multi_level_fold`) carrying every intermediate fold level in addition to the openings, leaf hashes, and root - five is the smallest leaf count at which a per-level re-sort of the fold (the error section 7 used to describe) produces a different root than the one this specification's actual `buildMerkle` rule produces, so this vector is what makes section 7's no-re-sort rule falsifiable rather than merely asserted.
- `inclusionVectors` - the section 8 worked example: one valid inclusion proof over the three-leaf tree above (`size_3_pet_profile_leaf0_inclusion`), one deliberately-tampered negative sharing the same proof and root (`size_3_pet_profile_leaf0_tampered_value`), and one valid proof over the same three-leaf tree containing a `{promote}` step (`size_3_pet_profile_leaf2_species_promote_inclusion`) - the first two vectors use only `{sibling}` steps; plus a fourth, deeper proof over the five-leaf tree above (`size_5_multi_level_leaf_name_double_promote_inclusion`, for `credentialSubject.name`), the first vector in the file with 3 steps and with two CONSECUTIVE `{promote}` steps, which is what pins section 8's one-step-per-tree-level rule and consecutive promotion on a tree taller than two levels.
- `dogTagIdFieldVectors` - the section 11 worked example plus two boundary handles (`"0"`, `"1"`), all three cross-checked against the pre-existing TS/Rust parity fixture in `test/profile_bind.test.ts`.
- `redactedArtifactVectors` (section 15) - the section 7 three-leaf tree, extended with the three reserved owner-control hashes every real profile tree carries, disclosed in full (`profile_tree_base_full_artifact`) and then masked in increasing degree - one leaf (`masked_variant_species_obfuscated`), then all three (`masked_variant_fully_obfuscated`) - with the root proven unchanged at every step; plus two negatives, an overlap (`negative_overlap`: a leaf claimed as both disclosed and separately obfuscated) and a reserved hash relabeled as obfuscated (`negative_reserved_relabeled_as_obfuscated`: the root is bit-identical to `masked_variant_species_obfuscated`'s, so only the exactly-3-reserved-hashes count check rejects it).
  Six more isolating negatives, promoted from `packages/dogtag-standard-ts/testvectors.json` by `packages/dogtag-standard-ts/scripts/promote-spec-vectors.ts` (never hand-copied: every hash is recomputed and every artifact is re-verified against the real `verifyRedactedArtifact` before being written), extend this to the seven checks section 13 now names: `negative_overlap_root_preserving_duplicate_leaf` and `negative_overlap_reserved_half_matches_disclosed` isolate the overlap check's two halves, `negative_duplicate_pet_keypath_no_identity_oracle` isolates the duplicate-keyPath guard, `negative_65_leaves_genuine_root_over_cap` isolates the 64-leaf cap, and `negative_hex32_shape_reserved_missing_0x_prefix`/`negative_hex32_shape_obfuscated_missing_0x_prefix` isolate the two hex32-shape checks - every one of these six carries the genuine root of its own exact leaf multiset, so only the named check can be the reason `verifyRedactedArtifact` rejects it.
- `recordArtifactVectors` (section 16, WP4.14S) - the `RecordArtifact` sibling of `redactedArtifactVectors` above, over a tree with NO reserved leaves: a full artifact disclosing all seven non-maskable leaves plus two ordinary clinical leaves (`record_full_artifact`), a masked variant withholding one clinical (maskable) leaf with the root proven unchanged (`record_masked_clinical_leaf`), and a variant masking every leaf EXCEPT the seven-member non-maskable set (`record_masked_except_non_maskable`) - the falsifiable demonstration that the non-maskable set, unlike `redactedArtifactVectors`' empty one, is real; plus three root-preserving negatives, each isolating exactly one check the same way section 15's own promoted negatives do: `record_negative_masked_dogtagid` (the `credentialSubject.dogTagId` leaf's hash moved to `obfuscatedLeafHashes`, root unchanged, isolating the non-maskable-set check), `record_negative_reserved_present` (a hash placed in `reservedLeafHashes` and folded into the posted root, isolating the reserved-must-be-empty check), and `record_negative_overlap` (a genuinely duplicated clinical leaf, one copy disclosed and the other copy's hash obfuscated, isolating the overlap check - the same construction as `negative_overlap_root_preserving_duplicate_leaf`, not the non-isolating `negative_overlap` shape section 15 itself warns against).
  Generated the same way as `redactedArtifactVectors`'s promoted entries: computed directly via the real `hashLeaf`/`buildMerkle`/`verifyRecordArtifact`, never hand-typed, by `packages/dogtag-standard-ts/scripts/promote-spec-vectors.ts`.

This repository ALSO carries a larger, older vectors file, `packages/dogtag-standard-ts/testvectors.json` (cross-language TS/Rust/Swift parity fixtures, asserted by `test/parity.test.ts` and `test/sdk.test.ts`).
That file remains the day-to-day cross-language parity gate for this repository's own implementations; `specs/leaf-commitment-vectors.json` is the smaller, curated, PUBLIC conformance set this specification itself defines, chosen for readability and worked-example value rather than exhaustive coverage.
The two do not conflict: every hashing rule `specs/leaf-commitment-vectors.json` exercises is the same rule `testvectors.json` exercises at greater scale.
`testvectors.json` separately carries its OWN, larger `redactedArtifacts` section (15 vectors) for the same cross-language purpose; this section's `redactedArtifactVectors` (11 vectors, six of them promoted from that larger set) is the smaller, curated illustration of the identical algorithm, exactly mirroring how the two files already divide the leaf/merkle/inclusion primitives above.

## 15. Redacted artifacts (selective disclosure by obfuscation)

Sections 1-14 describe how a credential's leaves fold into one root `R`.
This section describes a second, independent thing built entirely on top of that primitive, introducing no new hashing, encoding, or tree-construction rule of its own: a REDACTED ARTIFACT, the selective-disclosure-by-obfuscation format for a device-built profile tree (the same tree section 9's three reserved leaves and section 10's 64-leaf cap already describe).
Where `verifyInclusion` (section 8) discloses one leaf at a time against an anchored root, a redacted artifact discloses a whole subset of a tree's attribute leaves at once, while still proving every field a verifier does not see was genuinely part of the same committed tree - never fabricated, never substituted.

### The wire format

A redacted artifact is a `TagArtifact`-shaped custody record - the same shape a vet platform's custody store already holds for an issued tag - with some attribute leaves OPENED (`disclosed`) and the rest named only by their opaque hash (`obfuscatedLeafHashes`):

```
RedactedTagArtifact = {
  protocolVersion, schemaId?, dogTagIdDec?, dogTagIdField,
  root,
  disclosed: [{keyPath, saltHex, tag, value}, ...],
  obfuscatedLeafHashes: [0x.. x N],
  reservedLeafHashes: [0x.. x 3],
  issuerClone,
}
```

A full, unredacted artifact is the DEGENERATE case of this exact same shape: `obfuscatedLeafHashes` is empty, and `disclosed` holds every attribute leaf the tree ever committed to.
Masking a field is therefore never a different operation from disclosing one; it is the same field, moved from one array to the other, with its opening dropped and only its hash retained.
`dogTagIdField` (mirrored, for display, by `dogTagIdDec`) sits OUTSIDE `disclosed` and `obfuscatedLeafHashes` entirely: it is never a leaf, so it is never a candidate for masking in the first place, and it is unconditionally present on every redacted artifact, full or masked alike.
On the wire, `dogTagIdField` is a canonical non-negative DECIMAL STRING, never `0x`-prefixed hex - the same convention `dogtag-vet/src/lib/models/TagArtifact.ts` states explicitly for its own `dogTagIdField` column ("the DECIMAL STRING of the field element"), and the one `specs/schemas/dogtag.redacted-tag-artifact.v1.schema.json`'s `decimalString` `$def` enforces for this property; this is a wire-shape choice independent of section 11's derivation, which shows the SAME field element in both decimal and hex to illustrate the underlying math, not to imply either is an acceptable wire encoding here.
This is the identity anchor a verifier binds on-chain (`profileRoot(dogTagIdField) == root`); section 9's three reserved leaves are the identity anchor for CUSTODY (the owner's own control of the tag), a separate concern this format leaves untouched.

### The verification algorithm

`verifyRedactedArtifact(artifact, opts?)` - `opts.expectedIdentityLeaves` being the one field of interest here - is the normative check, a composition of exactly the primitives sections 6 and 7 already define - `hashLeaf` and `buildMerkle` - plus the same reserved-owner-namespace and duplicate-keyPath guards section 9's rejection rule already states:

1. `reservedLeafHashes` has exactly 3 entries, each a well-formed 32-byte hex string; every `obfuscatedLeafHashes` entry is likewise well-formed; the total leaf count (`disclosed.length + obfuscatedLeafHashes.length + reservedLeafHashes.length`) does not exceed 64 (section 10's cap, unchanged); `root` is a well-formed 32-byte hex string.
2. No `disclosed` entry's keyPath falls inside the reserved owner-control namespace (`owner.*` outside `owner.identity.*`, section 9's rejection rule); no two `disclosed` entries recompute to the same keyPath field.
3. Every `disclosed` leaf's hash is RECOMPUTED from its opening via `hashLeaf` - never trusted as posted - and rejected if it equals any `obfuscatedLeafHashes` or `reservedLeafHashes` entry: a field can never be simultaneously opened and masked (or opened and reserved).
4. `buildMerkle` over the union of the recomputed disclosed hashes, the obfuscated hashes, and the reserved hashes equals `root` exactly, using the identical sorted, commutative fold section 7 defines - no separate tree-construction rule exists for a redacted artifact.

Step 3's overlap check is LOAD-BEARING, not wire hygiene (corrected; a prior revision of this section claimed the opposite - see below): a root-preserving overlap between a `disclosed` opening and an `obfuscatedLeafHashes`/`reservedLeafHashes` entry IS constructible without any Poseidon collision, whenever the committed tree genuinely contains the same leaf hash twice.
The device-side tree builder (`build_profile_tree`, `profile_tree.rs`) permits exactly this among attribute leaves: reading its attribute loop to the end shows it enforces keyPath uniqueness ONLY against the three reserved keyPaths, never across attribute leaves, so two attribute leaves may legitimately fold to the same hash (for example, a duplicated keyPath/salt/value triple submitted twice).
When that happens, opening one copy and separately obfuscating the other copy produces an artifact whose root recomputes bit-for-bit identically to the genuine tree's root - step 4's root check alone would ACCEPT it - and step 3's overlap check is the ONLY thing that rejects it; step 1's total-leaf-count arithmetic does not help either, since the count is identical either way.
The overlap check therefore rejects a class of artifact the root check alone would accept, rather than merely restating a rejection some other check would already reach; it exists to keep `disclosed` and the opaque arrays (`obfuscatedLeafHashes`, `reservedLeafHashes`) disjoint on the wire, with a precise, attributable cause.
(A prior revision of this paragraph stated the opposite - that no such overlap is constructible without a Poseidon collision - and reasoned from that false premise that the check was wire hygiene rather than an independent boundary; that reasoning is what let two rounds of test-suite review miss that this check had no test able to detect its removal, since the premise implied no such test could exist to write. See `redactedArtifact.test.ts`'s and `redacted_artifact.rs`'s "root-preserving overlap" bite-proof tests for the constructed counterexample, run against the real implementation.)
A caller binds the result on-chain exactly as it would a full artifact, unchanged by this format: `profileRoot(dogTagIdField) == root`, `rootIssuer[root]` resolving to a trusted issuer, and `isValid(root)` on that issuer's clone.
The optional `opts.expectedIdentityLeaves` field, when supplied, additionally requires the `owner.identity.*` subset of the recomputed disclosed leaves to equal it as an exact multiset - the same cross-check the bind-time verifier below always performs, generalized here to something a caller supplies only when it actually holds a vet-attested record to check against.

`impl:` `packages/dogtag-standard-ts/src/redactedArtifact.ts` (`RedactedTagArtifact`, `verifyRedactedArtifact`), `crates/dogtag-standard-rs/src/redacted_artifact.rs` (`RedactedTagArtifact`, `verify_redacted_artifact`).

### A strict generalization of the bind-time leaf-commitment check

This document's reference implementation also carries `packages/dogtag-standard-ts/src/profileBind.ts`'s `verifyLeafCommitment`, the bind-time check a vet platform runs before it ever seals a root on-chain.
`verifyLeafCommitment` already performs steps 1-3 above over a tree with nothing obfuscated - every non-reserved leaf it sees is fully opened - and its identity cross-check is MANDATORY rather than optional, because a vet issuing a tag always holds the record it is cross-checking against.
`verifyRedactedArtifact` is exactly this same check with two axes generalized: some attribute leaves may be named only by their hash instead of fully opened, and the identity cross-check becomes optional rather than mandatory.
Setting `obfuscatedLeafHashes` to empty and always supplying `expectedIdentityLeaves` recovers `verifyLeafCommitment`'s behavior on every case a genuine device-built tree can reach, WITH ONE DOCUMENTED EXCEPTION (corrected; a prior revision of this sentence claimed unqualified exact equivalence): `verifyRedactedArtifact` additionally rejects a disclosed leaf whose recomputed hash equals a RESERVED hash (step 3's overlap check applied to the reserved half), a case `verifyLeafCommitment` does not check at all.
That one axis makes `verifyRedactedArtifact` STRICTLY MORE CONSERVATIVE than `verifyLeafCommitment`, never more permissive: the divergence is a false NEGATIVE on a pathological wire input `verifyLeafCommitment` would accept, not a false positive, and it is unreachable against a genuinely device-built tree (the reserved leaves are folded via `hash_reserved_leaf`'s raw-field slot, so making one collide with an ordinary `hashLeaf` output needs a Poseidon preimage, not merely a permissive tree builder).
Equivalence on every other case is verified in `packages/dogtag-standard-ts/test/redacted_artifact.test.ts` against every one of `verifyLeafCommitment`'s own test fixtures, accept and reject cases alike; the one documented divergence is pinned by its own test in the same file (and mirrored, for the Rust side of the overlap check alone, in `redacted_artifact.rs` - Rust has no `verifyLeafCommitment` twin to diverge from).

### The non-maskable set: none, by evidence

An implementation might be tempted to reserve one attribute keyPath as always-disclosed, by analogy with `credentialSubject.dogTagId`: the ONE leaf a signed `WrappedDoc` credential's own obfuscation primitive (`wrap.ts`'s `obfuscate`, `verify.ts`'s `checkIntegrity`) refuses to let a holder mask, because that format's identity binding lives INSIDE the hashed `data`, as an ordinary leaf among the credential's other fields.
No such keyPath exists for a redacted artifact, and this is a finding, not a design choice.
The device-side tree builder (`crates/dogtag-standard-rs/src/profile_tree.rs::build_profile_tree`) takes the canonical dogTagId field as a bare key-derivation input, never as an attribute leaf, and the frozen consent circuit states the same fact about the tree it proves membership in: `circuits/consent.circom`'s own header comment says plainly that the dogTagId-to-root binding is anchored ON-CHAIN, never inside any circuit or tree leaf.
This is the structural reason the two formats' non-maskable sets differ: a `WrappedDoc`'s identity binding is a LEAF, so its obfuscation primitive must special-case refusing to mask it, while a redacted artifact's identity binding (`dogTagIdField`) is not a leaf at all, so there is nothing inside `disclosed`/`obfuscatedLeafHashes` for a masking rule to even apply to in the first place.
(`specs/schemas/leaf-dictionary.v1.json` separately marks `credentialSubject.dogTagId` `"required"` - that dictionary describes the leaves a `schema.ts`-valid, `WrappedDoc`-shaped credential's `flatten()` walk produces, the SAME leaf this paragraph already distinguishes, and is not a claim about a profile tree's leaves at all.)
Every attribute leaf a redacted artifact carries is therefore maskable without exception - including, in the limit, all of them at once (`disclosed: []`, every attribute in `obfuscatedLeafHashes`), which still verifies: the artifact then proves only that root `R` was genuinely issued over some committed set of attributes, disclosing nothing about their content.
The one structural invariant that is NOT maskable is the reserved leaf triple's count and slot, and it is not a keyPath rule at all: `reservedLeafHashes` must carry exactly 3 entries, because a hash moved between `reservedLeafHashes` and `obfuscatedLeafHashes` changes nothing about the multiset `buildMerkle` folds.
The exactly-3 count check is the only thing that keeps the two arrays' bookkeeping meaning - opaque BY CONSTRUCTION versus opaque BY CHOICE, section 9 - from collapsing into an unenforceable, purely cosmetic distinction; the worked negative example below demonstrates this directly.

### Why not JSON.stringify

An OpenAttestation-style redaction scheme that hashes a document's JSON serialization directly ties every commitment to that one serialization's exact byte layout: key order, whitespace, and number formatting all become load-bearing, and two logically-identical documents that merely serialize differently commit to different hashes.
Nothing in this format ever hashes a JSON string.
Every disclosed leaf's opening is the same canonically typed scalar section 1's TypedScalar model and section 2's canonical encoding already define - an Integer is a canonical decimal-digit ASCII string, a Decimal strips trailing fractional zeros before encoding, a String is NFC-normalized UTF-8 - and `hashLeaf` (section 6) folds that canonical encoding, never a serialized document.
This is why `"22.70"` and `"22.7"` hash identically (section 6's worked example) while a JSON-stringify-based scheme would treat them as different bytes entirely, and it is why re-serializing a redacted artifact's `disclosed` array in a different key order, or with different whitespace, changes nothing about whether it verifies: `verifyRedactedArtifact` only ever reads the typed fields (`keyPath`, `saltHex`, `tag`, `value`) out of each entry, never a serialized form of the entry itself.

### Relation to ProfileDisclosure and the reserved leaves

Section 8 already defines a different selective-disclosure surface, `ProfileDisclosure`: a per-leaf inclusion proof against an anchored root, one `Sibling | Promote` path per disclosed leaf, which hides the tree's total leaf count from a verifier - a proof for one leaf reveals nothing about how many siblings the tree has beyond that one proof's own depth.
A redacted artifact instead reveals the tree's full shape - every leaf's hash is present, in `disclosed`, `obfuscatedLeafHashes`, or `reservedLeafHashes` - while hiding only the openings of the leaves it masks.
The two formats trade off different things for different consumers: `ProfileDisclosure` for a verifier who should not learn how much else exists, a redacted artifact for a verifier or a new custodian who needs the whole committed structure to keep operating on the tag - re-deriving `R`, checking the 64-leaf cap, or later disclosing a currently-masked field - while still being shown fewer field VALUES than a full artifact carries.
The three reserved leaves (section 9) are untouched by either format: `ProfileDisclosure` refuses to disclose them by name (section 9's rejection rule, applied a second time), and a redacted artifact never opens them at all - they live only in `reservedLeafHashes`, exactly as they already live only as opaque hashes in a full, unredacted artifact today.

### Worked example: masking a leaf without moving the root

Extending section 7's three-leaf worked example (`credentialSubject.name` = `"Rex"`, `credentialSubject.species` = `"dog"`, `credentialSubject.microchip.code` = `"985141006580319"`) to a real profile tree, by adding the three reserved owner-control hashes every such tree carries, produces the root `0x1a83320d99311513328b702a719dcd59f87b3892e1a04f339937dceaa9de02a8` (`redactedArtifactVectors[0]`, `"profile_tree_base_full_artifact"`).
Masking `species` - moving its leaf hash `0x1e2a8b2327908e91408416c14f99554c373d9ebad6571754b82cf319f676953d` (the same hash section 7 already quotes) into `obfuscatedLeafHashes` and dropping its opening from `disclosed` - reproduces the identical root (`redactedArtifactVectors[1]`, `"masked_variant_species_obfuscated"`): `buildMerkle` folds the same five leaf hashes either way, so which array names each one is invisible to the root.
Masking all three attribute leaves at once (`redactedArtifactVectors[2]`, `"masked_variant_fully_obfuscated"`, `disclosed` empty) reproduces that same root again - the falsifiable demonstration of this section's non-maskable-set finding.

### Worked example, including negative cases

`redactedArtifactVectors[3]` (`"negative_overlap"`) discloses `species` fully and separately lists its hash in `obfuscatedLeafHashes`.
Every individual hash involved is genuine, and `verifyRedactedArtifact` does reject it via step 3's overlap check in the current implementation's execution order, because a field can never be simultaneously opened and masked - but this particular vector does not ISOLATE that check (corrected note, WP4.10S fix round 1, D4): it posts 7 hashes (3 reserved + 3 disclosed + the redundant obfuscated entry) against a root built over only 6 unique ones, so step 4's root comparison would already reject it too, for an unrelated reason, if the overlap check were ever deleted.
The construction that DOES isolate the overlap check - a tree genuinely containing a duplicated attribute leaf hash, opened once and separately obfuscated once, with the root built over that exact multiset so it recomputes bit-for-bit regardless - is `negative_overlap_root_preserving_duplicate_leaf` (the obfuscated-half comparison: `species` is committed twice, one copy disclosed and the other separately obfuscated) and `negative_overlap_reserved_half_matches_disclosed` (the reserved-half comparison: `reservedLeafHashes[0]` is deliberately set equal to a disclosed leaf's recomputed hash), both promoted into this curated set from `testvectors.json`'s own unit-test-proven constructions (WP4.10S fix round 1) so a third-language implementation can no longer omit either half of this check and still conform.
`redactedArtifactVectors[4]` (`"negative_reserved_relabeled_as_obfuscated"`) moves one of the three reserved hashes into `obfuscatedLeafHashes`, leaving only two `reservedLeafHashes`.
The leaf multiset `buildMerkle` folds is unchanged by this relabeling - the same five hashes, just partitioned across the two arrays differently - so the recomputed root, `0x1a83320d99311513328b702a719dcd59f87b3892e1a04f339937dceaa9de02a8`, is bit-identical to `masked_variant_species_obfuscated`'s.
`verifyRedactedArtifact` still rejects it, and for exactly one reason: step 1's exactly-3-reserved-hashes count check, the only check in this algorithm that can tell a reserved hash apart from an obfuscated one once both are reduced to opaque field elements.
This is the concrete demonstration of why that count check is normative rather than a redundant sanity check: without it, `reservedLeafHashes` and `obfuscatedLeafHashes` would be interchangeable, and the always-opaque/opaque-by-choice distinction section 9 and this section both draw would be unenforceable.
Four more promoted vectors (WP4.10S fix round 1) each isolate one further check the same way, by carrying the genuine root of their own exact leaf multiset so no other check can be the reason `verifyRedactedArtifact` rejects them.
`negative_duplicate_pet_keypath_no_identity_oracle` isolates step 2's duplicate-keyPath guard: `credentialSubject.name` is disclosed twice, with different salts, and both openings genuinely fold into the posted root, so only the duplicate-keyPath check - never the root comparison - can reject it.
`negative_65_leaves_genuine_root_over_cap` isolates step 1's 64-leaf cap: it posts 65 total leaf hashes (3 reserved plus 62 disclosed attribute leaves, one more than section 10's cap allows) carrying their own genuine root, so only the total-leaf-count check can reject it; the vector is necessarily large, since 65 is the smallest leaf count that both exceeds the cap and still recomputes a self-consistent root.
`negative_hex32_shape_reserved_missing_0x_prefix` and `negative_hex32_shape_obfuscated_missing_0x_prefix` isolate step 1's hex32-shape checks: each posts one `reservedLeafHashes`/`obfuscatedLeafHashes` entry with its `"0x"` prefix stripped - still the correct field element once decoded, since the parser folding it into the root treats the prefix as optional - so only the shape check itself, which requires the literal prefix, can reject it.

## 16. Record artifacts (WP4.14)

Section 15 describes `RedactedTagArtifact`, an opened-leaf tree built over a device's PROFILE tree - a tree that always folds in the three reserved owner-control leaves (section 9), and whose identity anchor (`dogTagIdField`) lives OUTSIDE the tree entirely because the chain binds it separately (`profileRoot(dogTagIdField) == root`).
This section describes a second, sibling opened-leaf format, `RecordArtifact` (WP4.14, vaccination records and future record types alike), built over a DIFFERENT kind of tree: one with NO reserved leaves at all, whose on-chain anchor is `issueRecord(recordType, root)` - a root-keyed anchor with no owner-control material folded into it, ever.
The two formats share every hashing and tree-construction rule (this document introduces no new primitive here either); they differ only in POLICY, enumerated below.

### The wire format

```
RecordArtifact = {
  protocolVersion, artifactType: "record", schemaId?,
  root,
  disclosed: [{keyPath, saltHex, tag, value}, ...],
  obfuscatedLeafHashes: [0x.. x N],
  reservedLeafHashes: [],
}
```

`artifactType` is a WIRE-FORMAT discriminator a receiver reads before deciding which verifier and which policy to apply - `"record"` here, contrasted with a `RedactedTagArtifact`'s implicit `"tag"` (a legacy wire payload from before this field existed carries no `artifactType` at all, and is treated as `"tag"` by omission).
It is not itself a leaf and not a claim this document's cryptography checks; it is exactly as load-bearing as a tagged union's discriminant field always is, no more.

Unlike `RedactedTagArtifact`, a `RecordArtifact` carries no top-level `dogTagIdField`/`dogTagIdDec`, no top-level `issuerClone`, and no top-level `recordType` field.
This is a deliberate consequence of the non-maskable set below, not an oversight: `credentialSubject.dogTagId`, `issuer.contract`, and `recordType` are each themselves NON-MASKABLE DISCLOSED LEAVES on every valid `RecordArtifact` (never absent, by construction, once `verifyRecordArtifact` has accepted the artifact), so a second, top-level, UNCHECKED copy of any of them would only invite the value shown to a reader to drift from the value the root actually commits to - exactly the class of risk section 15's own overlap-check finding is a worked example of (two copies of a fact, only one of them actually checked, is worse than one copy).
A caller that wants any of these three values reads it straight out of `disclosed` once `verifyRecordArtifact` has returned `true`; there is nothing to mirror at the top level in the first place.

`schemaId` (optional) is the one top-level field this format keeps despite that reasoning, and it is treated differently from the three dropped above precisely because its own committed counterpart, `credentialSchema.id`, is ALSO always a non-maskable disclosed leaf: `verifyRecordArtifact` cross-checks it - when present, `schemaId` MUST equal the disclosed `credentialSchema.id` leaf's value exactly, and an artifact whose two copies disagree is rejected outright, closing the identical drift risk the paragraph above describes rather than accepting it for this one field.
Contrast `RedactedTagArtifact`'s own `schemaId` (section 15), which has no committed leaf counterpart in a profile tree to diverge from at all, and so is never cross-checked - the two fields share a name and a wire position, not a verification rule.

### Relation between a record's registry schema and its leaves

A per-record-type registry schema (`specs/schemas/dogtag.vaccination.v1.schema.json` for `VACCINATION`) describes the shape of the PRE-HASH CREDENTIAL DOCUMENT `credentialSchema.id` names - the same JSON object a fixture in `packages/dogtag-standard-ts/test/vaccination_schema.test.ts` validates directly against it - and NOT the shape of a `RecordArtifact`'s `disclosed` array, which is that same document's FLATTENED leaf image (`flatten()`'s keyPath/value pairs, each independently salted and hashed), of which a masked artifact legitimately discloses only a subset (the seven non-maskable keyPaths at minimum, per below).
`recordArtifactVectors` (`specs/leaf-commitment-vectors.json`, sections 13-14) are deliberately MINIMAL illustrations of this relationship - the seven non-maskable leaves plus two ordinary clinical ones, never a complete credential satisfying every envelope-required field (`@context`, `credentialStatus`, `signatureTrustTier`, and so on) - because a vector's job is to prove the Merkle mechanics `verifyRecordArtifact` checks, not registry-schema conformance, which `vaccination_schema.test.ts` proves separately, directly against the registry schema itself, over a fixture built for that purpose.

### The non-maskable set: exactly seven keyPaths, by decision

Section 15 found `RedactedTagArtifact`'s non-maskable set to be NONE, by evidence: no leaf in a profile tree is structurally special in a way that would justify refusing to let it be masked.
`RecordArtifact`'s non-maskable set is the opposite finding, by DECISION (Kenneth, WP4.14 plan section 10, confirmed round 2 item 5 and round 3): exactly these seven keyPaths MUST be present, fully opened, in `disclosed` on every valid record artifact -

```
credentialSubject.dogTagId
recordType
credentialSchema.id
credentialSchema.version
issuer.chainId
issuer.contract
issuer.operator
```

`verifyRecordArtifact` rejects an artifact where any of the seven is missing from `disclosed` entirely, or named only by its hash in `obfuscatedLeafHashes` - moving one of these seven from `disclosed` to `obfuscatedLeafHashes` is caught by this check even though it leaves the recomputed `root` bit-for-bit unchanged (the identical "which array names a hash" bookkeeping distinction section 15's `negative_reserved_relabeled_as_obfuscated` worked example already demonstrates for a different pair of arrays).
Presence is checked the same NFC-normalized, field-level way section 9's rejection rule and section 15 step 2's duplicate-keyPath guard already compare keyPaths - never a bare string `===`, so no NFC-alias spelling of one of the seven can evade the check by construction, the identical reasoning section 9 states for its own prefix guard.

Why each of the seven is on this list:

- `credentialSubject.dogTagId` - the chain stores no record-to-dog association at all (unlike a profile tree, whose `dogTagId` is bound on-chain by `profileRoot`); this leaf is a record's ONLY link to a dog, so masking it would produce an artifact that verifies perfectly while proving nothing about which pet it is for.
- `recordType` - the value the on-chain binding rule below checks against `recordTypeOf(root)`; without it disclosed, a verifier has a root and no way to ask the chain the one question (which record type is this?) needed to interpret it.
- `credentialSchema.id` / `credentialSchema.version` - which DogTag registry schema (`specs/schemas/`) this record's field set was actually issued against; independent of, and never to be confused with, the record's separate UNCOMMITTED `conformsTo[]` claim about which EXTERNAL standards (FHIR, NASPHV, the EU passport model) the same data also happens to satisfy (below) - `specs/schemas/README.md` already states credential SHAPE and leaf ENCODING are independent axes, and this is the identical independence applied to "which registry schema" versus "which external standard".
- `issuer.chainId` / `issuer.contract` / `issuer.operator` - together these make a record self-describing OFFLINE (Kenneth round 2 item 3): a phone holding nothing but this one JSON blob can still name which chain, which contract, and which signer to ask, without any other stored context, before making a single RPC call.

Owner data - a pet owner's identity or wallet - is never a member of this set, and under the WP4.14 leaf list (plan section 4) never appears in a record's leaf set AT ALL: a record artifact carries no `owner.*`-namespaced leaf of any kind, maskable or not, unlike a profile tree's three ALWAYS-opaque reserved leaves (below).

### Reserved leaves: always empty, never present

`reservedLeafHashes` MUST be the empty array on every `RecordArtifact` - contra section 15's `RedactedTagArtifact`, which requires EXACTLY three.
A record's tree never had a reserved leaf to begin with: `issueRecord(recordType, root)` (`contracts/src/VetIssuer.sol`) anchors a root directly, with no owner-control material folded into it, so there is no legitimate construction under which a genuinely record-shaped tree contains one.
`verifyRecordArtifact` rejects any artifact whose `reservedLeafHashes` is non-empty, unconditionally - this is the mirror image of section 15's exactly-3 count check, and exists for the identical reason: without it, the meaning of "this array is always empty" would be unenforceable, and a hash smuggled into `reservedLeafHashes` would fold into `root` identically to one honestly placed in `obfuscatedLeafHashes` (`buildMerkle` does not care which array a hash came from), making the two indistinguishable from the root alone.

### The 64-leaf cap does not apply

Section 10 is explicit that its 64-leaf cap is a POLICY the CONSENT-BIND path layers on top of `buildMerkle`, driven entirely by the frozen depth-6 consent circuit's fixed witness shape (`circuits/consent.circom`, `component main = DogTagConsent(6)`) - it is not a property of `buildMerkle`/`verifyInclusion` themselves, and section 10 says plainly that the general primitive "accepts a tree of any positive leaf count, with no padding and no fixed depth."
A record artifact is never consent-proven: there is no reserved triple for `DogTagConsent` to prove membership of, and `issueRecord`'s own on-chain guard is `onlyActiveOperator`, unrelated to the ZK consent circuit entirely.
`verifyRecordArtifact` therefore places NO upper bound on `disclosed.length + obfuscatedLeafHashes.length` - a real difference from `verifyRedactedArtifact`, not an oversight, and `dogtag.record-artifact.v1.schema.json` correspondingly declares no `maxItems` bounding the two arrays together.

### The verification algorithm

`verifyRecordArtifact(artifact)` is, like `verifyRedactedArtifact`, a pure composition of `hashLeaf` and `buildMerkle` plus section 9's owner-namespace guard - with the non-maskable-set and always-empty-reserved rules above replacing section 15's differing rules, and with no expected-identity-leaves option (a record carries no owner identity leaves for such an oracle to check against in the first place):

1. `reservedLeafHashes` is exactly the empty array; every `obfuscatedLeafHashes` entry is a well-formed 32-byte hex string; `root` is a well-formed 32-byte hex string. (No total-leaf-count bound - see above.)
2. No `disclosed` entry's keyPath falls inside the reserved owner-control namespace (`owner.*` outside `owner.identity.*`, section 9's rejection rule, applied here defensively even though a genuinely-built record tree never has one to begin with); no two `disclosed` entries recompute to the same keyPath field.
3. Every one of the seven non-maskable keyPaths is present among `disclosed`'s (NFC-normalized, field-compared) keyPaths.
   **This check MUST run before step 5's Merkle fold.** It is what guarantees `disclosed` is never empty by the time `buildMerkle` is called: an artifact posting all three arrays empty (`disclosed: []`, `obfuscatedLeafHashes: []`, `reservedLeafHashes: []`) is rejected HERE, before `buildMerkle` ever sees it - `build_merkle` panics on an empty input in the Rust reference implementation, and a `RecordArtifact` has no reserved-triple floor the way a `RedactedTagArtifact` always does (section 15's own `build_merkle` call is safe only because the exactly-3-reserved check ahead of it guarantees a non-empty input by construction; the equivalent guarantee here comes from THIS check instead, since `reservedLeafHashes` contributes nothing).
   **Step 3b (schemaId cross-check):** if the top-level `schemaId` is present, it MUST equal the disclosed `credentialSchema.id` leaf's value exactly - safe to check here since step 3 above already guarantees that leaf is disclosed (see "The wire format" above for why this one top-level field is cross-checked where the three dropped ones simply do not exist).
4. Every `disclosed` leaf's hash is RECOMPUTED from its opening via `hashLeaf` - never trusted as posted - and rejected if it equals any `obfuscatedLeafHashes` entry (section 15's overlap rule, minus the reserved half, since a record artifact never has one).
5. `buildMerkle` over the union of the recomputed disclosed hashes and the obfuscated hashes (reserved contributes nothing) equals `root` exactly.

A caller binds the result on-chain via the rules below, deliberately not this pure function's job - exactly as section 15's own step 5 is a caller's job for a profile tree.

### On-chain binding rules

Where a `RedactedTagArtifact` binds via `profileRoot(dogTagIdField) == root` (section 15), a `RecordArtifact` binds via the root itself, cross-checked against the non-maskable leaves already disclosed on it:

1. `rootIssuer[root] == issuer.contract` - factory-anchored resolution: ask the verifier's OWN configured factory which clone issued this root; never trust a clone address the artifact or its sender names outside this cross-check (the same anti-substitution reasoning `packages/dogtag-standard-ts/src/verify.ts`'s `RpcAdapter.rootIssuer` already documents for every other artifact type this protocol verifies).
2. `recordTypeOf(root) == keccak256(recordType)`, read against the clone resolved in step 1 - `contracts/src/VetIssuer.sol`'s `mapping(bytes32 => bytes32) public recordTypeOf`, populated both by the original tag-issuance path and by `issueRecord(recordType, root)`.
   `keccak256` here is the EXACT SAME hash `packages/dogtag-standard-ts/src/verify.ts`'s `recordTypeKey` and `crates/dogtag-standard-rs/src/verify.rs`'s `record_type_key` already compute for the issuer-whitelist pillar (section 6 below extends those two functions' own on-chain read; this binding rule reuses the identical hash, not a new one).
3. `isValid(root)` on the clone resolved in step 1 - the same liveness/non-revocation check every other artifact type in this protocol already performs before trusting a root.
4. `issuedBy(root) == issuer.operator`, read against the clone resolved in step 1 - the wallet that actually called `issueRecord`, cross-checked against the leaf's own claim (the identical "resolve independently, then compare against the document's claim" pattern `verify.ts`'s `issuedBy`/whitelist pillar already uses).
5. the `issuer.chainId` leaf equals the chain ID the verifier is actually connected to - a trivial equality with no contract read at all, stated explicitly because skipping it would let an artifact genuinely anchored on one chain be replayed as if anchored on a different chain whose contract addresses happen to collide with the first's.

Every one of these five reads a NON-MASKABLE leaf's disclosed value, never a top-level envelope field (there is none to read - see "The wire format" above) - a verifier that has already passed the pure structural check knows all five values it needs are present and hash-consistent with `root` before making a single RPC call.

### Reporting validity once binding succeeds

`validFrom` and `validUntil` are ordinary MASKABLE clinical leaves (WP4.14, section on "The wire format" above), not part of the seven non-maskable keyPaths the on-chain binding rules above read. A record that passes every binding rule above may still disclose neither, either, or both of them - the binding rules alone say nothing about whether the record's own protection window currently covers "now". Once the five binding checks above all agree, a verifier reports one of five values by walking this ORDERED procedure and stopping at the first step that applies - a later step is never reached once an earlier one has fired:

1. `isValid(root)` is false -> `revoked`, unconditionally, ignoring both date leaves entirely. A revoked root is reported `revoked` even when both `validFrom` and `validUntil` are withheld, and even when a disclosed window would otherwise read as expired or not-yet-valid.
2. Otherwise, if `validFrom` or `validUntil` (or both) was withheld by the presenting device (moved into `obfuscatedLeafHashes`, permitted since neither is non-maskable) -> `hidden`. This check runs BEFORE any date comparison: a verifier that has not been shown the full window reports that it cannot tell, even when the one bound it WAS shown would, on its own, imply `expired`. This is the failure mode the state exists to close - a verifier silently defaulting to `valid` for an artifact that discloses everything EXCEPT the one leaf that would prove it expired years ago.
3. Otherwise, if `validFrom` is still in the future relative to the verifier's own clock (UTC) -> `not_yet_valid`. Distinct from `expired`, never collapsed into it - a record whose window has not opened yet is a different fact from one whose window has closed.
4. Otherwise, if the verifier's clock is past `validUntil`'s UTC end-of-day (the same T24:00:00Z cutoff this document already defines elsewhere for the tag side's own validity notion) -> `expired`. By this step both bounds are already known disclosed, since step 2 would have fired otherwise.
5. Otherwise -> `valid` - both bounds disclosed and the clock genuinely falls within `[validFrom, end-of-validUntil]`.

This is a single decision procedure, not one per consumer: a vet's own Records tab (reading its own rows directly, not through a presented artifact) and the `/v` verify ceremony (reading a presented, possibly-masked artifact) both compute this the same way, over whatever `validFrom`/`validUntil` values are actually available to each - the vet's own record always has both, since neither can be withheld from its own issuer's database; only a PRESENTED artifact can genuinely lack one.

### The uncommitted block: never hashed

A record is carried on the wire ALONGSIDE (never inside) its `RecordArtifact`, as a separate, UNCOMMITTED envelope block (WP4.14 plan sections 9-10, Kenneth round 3):

```
{
  conformsTo: [{standard, version}, ...],
  anchoring: {chainId, contract, txHash, blockNumber, blockTime},
  presentation: { ... },
}
```

None of `conformsTo`, `anchoring`, or `presentation` is ever a leaf, ever folded into `root`, or ever consulted by `verifyRecordArtifact` - each carries zero cryptographic weight, by design, and an implementation is free to omit, re-derive, or update any of them after the fact (for example, `anchoring.blockTime` maturing from pending to a confirmed timestamp as the transaction gets more confirmations) without invalidating `root` or requiring re-issuance, a flexibility no committed leaf could ever offer.

- `conformsTo` names zero or more `(standard, version)` pairs from `specs/standards/index.yaml` (`specs/standards/README.md`) that this record's data ALSO happens to satisfy - a claim independent of, and never a substitute for, the committed `credentialSchema.id`/`credentialSchema.version` leaves above, which name the DogTag registry schema the record was actually issued against.
- `anchoring` restates, for display convenience, facts the on-chain binding rules above independently verify (`chainId`/`contract` SHOULD equal the `issuer.chainId`/`issuer.contract` leaves where both exist - a mismatch here is a presentation bug to fix, never itself a verification failure, since a verifier that cares checks the leaves and the chain directly, never this block) plus `txHash`/`blockNumber`/`blockTime`, which have no leaf counterpart at all: the record's clinical `vaccinationDate` leaf is the medically-meaningful date, while the block number and chain time the `RecordIssued` receipt carries are anchoring metadata about WHEN THE CHAIN LEARNED ABOUT IT, a related but distinct fact (WP4.14 plan section 4).
- `presentation` is free-form rendering guidance (for example, WP4.11's dynamic renderer hints) with no normative content this document defines.

### Relation to redacted (tag) artifacts

A `RecordArtifact` and a `RedactedTagArtifact` (section 15) share every hashing and tree-construction primitive, and the identical masking mechanic - move a leaf's hash from `disclosed` to `obfuscatedLeafHashes`, its opening dropped and only the hash retained, the root unchanged either way.
Every difference between them is POLICY, never cryptography: which leaves are reserved (always exactly three, vs always none), which are non-maskable (none, by evidence, vs exactly seven, by decision), whether the 64-leaf cap applies (yes, a consent-bindable artifact, vs no), and how the root binds on-chain (`profileRoot(dogTagIdField) == root` vs `rootIssuer`/`recordTypeOf`/`issuedBy` read directly off `root` and the disclosed non-maskable leaves).
`artifactType` is the wire-level discriminator a receiver reads to know which policy - and which verifier - applies before it ever inspects a single leaf.

`impl:` `packages/dogtag-standard-ts/src/recordArtifact.ts` (`RecordArtifact`, `verifyRecordArtifact`), `crates/dogtag-standard-rs/src/record_artifact.rs` (`RecordArtifact`, `verify_record_artifact`).
