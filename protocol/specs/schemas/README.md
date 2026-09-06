# DogTag credential schema registry (S2)

This directory is the machine-readable schema registry for DogTag credentials.
It is the source of truth for credential SHAPE (record types, required fields, enums, patterns).
It is a different document from `specs/leaf-commitment.md`, the source of truth for the ENCODING that turns a shape-valid credential into a Merkle root.
A credential must satisfy both: this registry says what a `DOG_PROFILE` credential must contain, `leaf-commitment.md` says how any credential's contents become leaves and a root.

## Files

- `dogtag.envelope.v1.schema.json` - the shared W3C VC 2.0 envelope and legal-meta fields every record type composes via `allOf`.
  Not itself one of the five record types the WP4.9 plan names; a deliberate DRY building block so five near-identical envelope blocks cannot drift apart from each other.
- `dogtag.dog-profile.v1.schema.json`, `dogtag.rabies-vaccination.v1.schema.json`, `dogtag.service-attestation.v1.schema.json`, `dogtag.eu-health-cert.v1.schema.json`, `dogtag.cdc-import-form.v1.schema.json` - one JSON Schema (draft 2020-12) per record type `packages/dogtag-standard-ts/src/schema.ts` validates.
- `dogtag.redacted-tag-artifact.v1.schema.json` (WP4.10S) - NOT one of the five VC record types above and NOT composed with `dogtag.envelope.v1`: this describes the shape of a `RedactedTagArtifact`, the selective-disclosure-by-obfuscation custody/export wire record `specs/leaf-commitment.md` section 15 defines over a device-built profile tree, a different kind of object from a signed VC credential entirely.
  It has no `schema.ts` counterpart to mirror (there is no `validateSchema`-equivalent for this shape anywhere in this repo) - its own conformance test (`packages/dogtag-standard-ts/test/redacted_artifact_schema.test.ts`) instead cross-checks it bidirectionally against `verifyRedactedArtifact`'s structural checks (reserved-hash count, hex32 shape), the closest thing this format has to a "code" side.
- `dogtag.record-artifact.v1.schema.json` (WP4.14S) - the `RecordArtifact` sibling of the entry above: the selective-disclosure-by-obfuscation wire record `specs/leaf-commitment.md` section 16 defines over a record's OWN opened-leaf tree (no reserved owner-control leaves, unlike a profile tree). Same "no `schema.ts` counterpart" position as `dogtag.redacted-tag-artifact.v1`; its own conformance test (`packages/dogtag-standard-ts/test/record_artifact_schema.test.ts`) cross-checks it bidirectionally against `verifyRecordArtifact`'s structural checks the same way.
- `dogtag.vaccination.v1.schema.json` (WP4.14S) - a SIXTH `recordType` shape, `allOf`-composed with `dogtag.envelope.v1` exactly like the five above, but UNLIKE them it has NO `schema.ts`/`validateSchema` counterpart at all (`schema.ts`'s only vaccination-shaped branch is `isRabies`, gated on `type` containing `RabiesVaccinationCertificate`, which is `dogtag.rabies-vaccination.v1` below, kept unchanged for interop).
  A credential shaped to this schema is never run through `wrap.ts`/`schema.ts`'s `WrappedDoc` pipeline; it is instead hashed directly into a `RecordArtifact` (`dogtag.record-artifact.v1.schema.json` above, `specs/leaf-commitment.md` section 16).
  Per the Conformance rule below, only the fields `verifyRecordArtifact`'s non-maskable-set check actually enforces (`recordType`, `credentialSubject.dogTagId`, `credentialSchema.id`/`credentialSchema.version`, `issuer.chainId`/`issuer.contract`/`issuer.operator`) carry real `required`/`const`/shape constraints; every clinical/FHIR field (`targetDisease`, `vaccineProductName`, `vaccinationDate`, and so on) is description-only, since no code in this repository validates their presence or type - see `specs/standards/README.md` for how these keyPaths relate to external standards like FHIR, NASPHV Form 51, and the EU pet passport model.
- `leaf-dictionary.v1.json` - every known post-flatten keyPath these credentials can produce, mapped to its allowed TypeTag(s), its requirement level, and prose notes.
  This is the leaf-commitment-layer counterpart to the pre-wrap shape files above; see its own `_comment` for how the two relate.
  It describes ONLY the `schema.ts`/`flatten()` pipeline's leaves (the five VC record types), never a profile tree's attribute leaves - `dogtag.redacted-tag-artifact.v1.schema.json` above is not, and does not need to be, described by this dictionary (see its own `_comment`'s WP4.10S note for why).

## Why JSON Schema, not RFC 8785 JCS

RFC 8785 (JSON Canonicalization Scheme) canonicalizes a whole JSON document for signing, and its number handling follows ECMAScript's IEEE-754 semantics - exactly the float representation `specs/leaf-commitment.md` bans by design (Integer and Decimal values are canonical-string-encoded there precisely to avoid float ambiguity).
JCS also has no notion of a per-leaf salted commitment; it canonicalizes the document as one opaque blob, which is the opposite of what a selectively-disclosable, per-field-salted Merkle tree needs.
The canonical encoding layer therefore stays this protocol's own pinned scheme (documented in `leaf-commitment.md`), and this registry's job is narrower and more conventional: describing credential SHAPE, for which JSON Schema is the standard, widely-tooled choice, and is what the W3C VC 2.0 `credentialSchema` field already expects (`{id, type: "JsonSchema"}`).

## How `credentialSchema` points here

Per the W3C VC-JSON-Schema specification, an issued credential's REQUIRED `credentialSchema` field names the exact schema it was issued against: `{id: "<one of the $id values above>", type: "JsonSchema"}`.
A verifier resolves `credentialSchema.id`, fetches (or already trusts a pinned copy of) that exact schema document, and validates the credential against it before trusting its shape at all - this registry is that fetch target.

## x-validationRules: what JSON Schema cannot express, and why

Every record-type schema carries a top-level `x-validationRules` array (empty where nothing applies).
Each entry is `{id, description, covers}`, where `covers` lists the exact `schema.ts` violation-message substrings the rule is responsible for.
A violation belongs here, rather than in the JSON Schema body, only when it is genuinely inexpressible in JSON Schema - primarily CROSS-FIELD DATE ARITHMETIC (adding N days or M calendar months to one date and comparing against another) and ARBITRARY-PRECISION DECIMAL-STRING MAGNITUDE comparisons (this protocol's Decimal values are canonical strings, never IEEE-754 numbers, and JSON Schema's `minimum`/`maximum` only operate on the `number` type).
Everything else - enums, patterns, `const`s, and even several conditional rules expressible via 2020-12's `if`/`then` - is encoded directly as real JSON Schema, because a rule that CAN be checked structurally should be, so a generic validator (not just this repository's own `schema.ts`) gets the benefit.

Concretely, only two record types carry any `x-validationRules` entries:

- `dogtag.rabies-vaccination.v1`: 5 entries (microchip-implant-before-vaccination, minimum age at vaccination, the primary-series `validFrom` offset, and the titer magnitude/sampled-after pair).
- `dogtag.eu-health-cert.v1`: 2 entries (the entry-date offset, the onward-validity month offset).

`dogtag.dog-profile.v1`, `dogtag.service-attestation.v1`, and `dogtag.cdc-import-form.v1` carry none - every rule `schema.ts` enforces for those three record types is fully expressible in JSON Schema (including the `echinococcusRequired`-conditioned range and the `cdcPath == "standard"` cross-cutting microchip requirement, both via `if`/`then`).

`packages/dogtag-standard-ts/test/schema_registry.test.ts` asserts this mapping is TOTAL over an ENUMERATED, PINNED set of violation cases (see that file's own header comment for the precise claim - it is "every violation case this suite enumerates is classified," not an automatically-derived proof over every violation `schema.ts` could ever produce, since `schema.ts` exports no machine-readable catalogue of its own violation messages to enumerate against).

## The `cdcPath == "standard"` cross-cutting rule

`schema.ts`'s `needsChip` flag (which makes `credentialSubject.microchip` required) is set by three independent conditions: `type` includes `RabiesVaccinationCertificate`, `recordType == "EU_HEALTH_CERT"`, or top-level `cdcPath == "standard"` - and that third condition is checked regardless of `recordType`, so in principle it could apply to a `DOG_PROFILE` or `SERVICE_ATTESTATION` credential too.
This registry structurally encodes that third condition (via `if`/`then`) only in `dogtag.cdc-import-form.v1`, the one record type it is documented against and the only realistic place a `cdcPath` field would appear.
If a real use case for `cdcPath == "standard"` on another record type ever appears, hoist the same `if`/`then` block into the shared envelope schema instead of duplicating it - see the versioning rule below for what that change counts as.

## Where TypeTag.Null nullability actually lives

The WP4.9 plan's section 1b.2 calls for "nullable fields expressed as `type: [..., \"null\"]` mapping 1:1 to TypeTag.Null" in these JSON Schema files.
Having read `schema.ts` field by field (every `reqPresent` call, every optional-field type check), no field in the CURRENT five record types accepts a literal JSON `null` as a value distinct from that field being absent: `reqPresent` rejects `null` exactly like `undefined`, and every optional field's own type check (`isString`, `isDecimalString`, `isObject`, ...) rejects `null` too (`isString(null)` is `false`, so e.g. `description: null` fails the SAME "must be a string" check `description: 42` would).
Adding a `type: [..., "null"]` union to any of these fields would therefore make this registry ACCEPT something `schema.ts` itself rejects - the wrong direction for a registry whose whole purpose is to never drift from the code it mirrors.
None of these six schema files use that union pattern as a result.

The `TypeTag.Null` nullability the plan is describing is real, it simply lives one layer down, in `leaf-dictionary.v1.json`'s `nullable` requirement category: a keyPath is nullable there when the POST-FLATTEN leaf can legitimately be a `{tag: Null, value: null}` scalar, either because F2a's empty-object/empty-array collapse rule produces one (`credentialSubject.weightHistory` when the array is present-but-empty is this registry's one example) or because a future field is deliberately designed to accept an explicit "redacted"/"not provided" commitment.
Nothing in this registry's plain-JSON schemas needs to represent that, because plain JSON's `null` and "key absent" collapse to the identical "not required, not provided" case everywhere `schema.ts` currently checks.

## Versioning rules (plan section 1b.2)

- Adding a new keyPath within a version is ALWAYS allowed and never requires a new `$id`.
  This mirrors the underlying tree primitive directly: `buildMerkle` has no fixed leaf count, so a new optional field is just a new possible leaf, not a breaking change.
  Envelope composition here follows the same rule for the same reason: every schema in this directory is deliberately open-world (no `additionalProperties`/`unevaluatedProperties` restriction), so a record schema is never broken by a sibling field a future revision adds to the shared envelope, or by an entirely new field a caller includes that no schema here names yet.
  Concretely, an additive keyPath is a MINOR TICK of the affected schema's informational `version` field (and of `leaf-dictionary.v1.json`'s own `version`, since it gained an entry too) - same `$id`, no `leaf-dictionary.v2.json`, and no protocol version bump, since neither a new TypeTag nor a canonicalization change is involved (`specs/leaf-commitment.md` section 12).
  WP4.12 is the worked example: `dogtag.dog-profile.v1.schema.json` and `leaf-dictionary.v1.json` both ticked 1.0.0 -> 1.1.0 when three optional String leaves were added under `credentialSubject` - `color`, `registrationId`, `registrationAuthority`.
  `schema.ts` does not know any of the three fields exist, so it validates nothing about them at all, not even presence, which is even less validation than `species`'s `reqPresent`-only check.
  Per "Conformance" below (the registry must never become STRICTER than the code it mirrors), each is therefore declared DESCRIPTION-ONLY in the schema - no `type` keyword and no `not: {type: null}` guard either, since even that would reject a value the code accepts.
  `leaf-dictionary.v1.json` still records the shape expected when a value IS present - `tags: ["String"]`, `requirement: "optional"` - so the schema says nothing about type while the dictionary still does.
  Their meanings: `color` is free-text coat color, e.g. brown; `registrationId` is a local government registration or licence id; `registrationAuthority` is the authority that issued registrationId, e.g. AVS Singapore, so the id stays unambiguous across jurisdictions.
- Changing a field's type or meaning is a SCHEMA VERSION bump: mint `.../v2` (a new `$id`), publish it alongside `v1` (never delete or silently mutate a published `$id` - a credential issued against `v1` must go on validating against `v1` forever), and update `leaf-dictionary.v1.json`'s successor (`leaf-dictionary.v2.json`) if the change affects a leaf-level tag or requirement.
- Changing the CANONICAL ENCODING or HASHING itself (a new TypeTag, a different canonicalization rule, a different Poseidon arity or domain tag) is a PROTOCOL version bump - a new universe (`dogtag-v3/1`-shaped), documented in `specs/leaf-commitment.md` section 12, never something this registry's versioning alone can express or gate.
  No schema-registry change, however large, is ever itself a protocol version bump; the converse also holds - a protocol version bump does not by itself require every schema `$id` here to change, since credential SHAPE and leaf ENCODING are independent axes.
- These rules apply to `dogtag.redacted-tag-artifact.v1.schema.json` exactly as to the five VC record types, even though it is not one: they are stated in terms of "a schema in this registry" and its `$id`, not in terms of `schema.ts`/`recordType`, so a future breaking change to the `RedactedTagArtifact` wire shape mints `.../v2` the same way a VC record type would, and a future protocol version bump (a new leaf-commitment universe) no more forces this schema's `$id` to change than it forces any other schema here to.
  `dogtag.record-artifact.v1.schema.json` (WP4.14S) follows the identical rule, for the identical reason, as the `RecordArtifact` wire-shape sibling of `RedactedTagArtifact`.
  `dogtag.vaccination.v1.schema.json` (WP4.14S) follows the ordinary VC-record-type versioning rule above (it IS one, `allOf`-composed with the envelope like the other five) even though it has no `schema.ts` counterpart: an additive keyPath is still a minor tick of its own `version` field under the same `$id`, and a shape-changing edit still mints `.../v2`.

## Conformance

A credential is registry-conformant for a given record type if and only if it validates against that record type's schema (`allOf` the shared envelope) AND satisfies every rule listed in that schema's `x-validationRules`.
`packages/dogtag-standard-ts/test/schema_registry.test.ts` pins `packages/dogtag-standard-ts/src/schema.ts` (`validateSchema`) against this registry so the two cannot drift apart silently: every valid fixture must pass both, and every violation `schema.ts` produces must be caught by the JSON Schema itself or explicitly named in an `x-validationRules.covers` entry - never neither.
`dogtag.redacted-tag-artifact.v1.schema.json` is conformance-checked separately, by `packages/dogtag-standard-ts/test/redacted_artifact_schema.test.ts`, exactly because it has no `schema.ts`/`recordType` counterpart for the check above to apply to.
It also pins the CONVERSE direction over an enumerated, pinned set of positive cases: a credential `validateSchema` accepts must validate against this registry too, so the registry can never silently become STRICTER than the code it mirrors (the failure mode that had `dogtag.rabies-vaccination.v1` requiring `credentialSubject.dateOfBirth`, which `schema.ts` requires only for `DOG_PROFILE`).
`dogtag.record-artifact.v1.schema.json` (WP4.14S) is conformance-checked the same separate way, by `packages/dogtag-standard-ts/test/record_artifact_schema.test.ts`, against `verifyRecordArtifact`'s structural checks instead of `validateSchema`.
`dogtag.vaccination.v1.schema.json` (WP4.14S) is a THIRD position: it IS one of `schema_registry.test.ts`'s registered `recordType` schemas (so its `x-validationRules`/strict-mode compilation are checked exactly like the five), but it has no `validateSchema` branch to pin bidirectionally against - `schema_registry.test.ts` does not attempt the fixture-pass/violation-coverage checks for it, since there is no `schema.ts` behavior on the other side of that check to mirror; its only "code" cross-check is `verifyRecordArtifact`'s non-maskable-set requirement, which is a check on a `RecordArtifact`'s disclosed leaves, not on this schema's pre-hash JSON shape.
