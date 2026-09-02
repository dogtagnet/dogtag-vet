/**
 * The schema-registry `$id` values this app's own custody writes stamp onto a `TagArtifact`
 * (WP4.10V item 2 - "every export/import payload carries protocolVersion + schemaId"). Centralized
 * here (rather than a local constant per call site) because THREE independent write paths need the
 * identical value: the custodial-bind terminal write (`issuedArtifactSideEffect.ts`), the WP4.4
 * mobile-booking tier-4 import side effect (`booking/mobileMongoAdapters.ts`), and the backfill
 * migration's both paths - fresh inserts and the legacy-row repair pass (`backfill.ts`) - a
 * duplicated magic string across those files would be exactly the kind of drift-prone repetition
 * this app's own house style avoids elsewhere (see `lib/reasonCodes.ts`'s single source of truth
 * for a parallel precedent).
 *
 * `DOG_PROFILE_SCHEMA_ID` is the one record type every leaf this app ever custodies (issued or
 * imported) structurally corresponds to - `MintProfile` (species/breedVbo/breedLabel/sex/
 * neuterStatus/dateOfBirth/weightHistory) is exactly `dogtag.dog-profile.v1.schema.json`'s shape,
 * and this app has no OTHER record-issuing path through custodial-bind, no other claim shape
 * through the WP4.4 booking tier-4 import, and no other historical record type a legacy row could
 * have predated this stamping under - see `issuedArtifactSideEffect.ts`'s original doc comment
 * (moved here) for the full reasoning and its honest limit (this is a pointer, not a fetched-and-
 * checked schema; no live registry validation happens against it here).
 */
export const DOG_PROFILE_SCHEMA_ID = "https://dogtag.io/schemas/dog-profile/v1";
