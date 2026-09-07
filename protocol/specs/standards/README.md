# DogTag external standards registry (WP4.14)

This directory catalogs external veterinary and health-record data standards this protocol recognizes.
It is a different document from `specs/schemas/` (the DogTag credential-shape registry) and from `specs/leaf-commitment.md` (the encoding/hashing spec).
Nothing here describes a DogTag credential's own shape or a record artifact's committed leaves - see those two instead for that.
This directory exists so a DogTag vaccination record can say, in its own words, which OUTSIDE standard(s) its data also happens to satisfy - FHIR, a national rabies-certificate form, an EU passport model - without DogTag's own committed leaf set ever depending on any of them.

## Files

- `index.yaml` - the list of recognized standards: `{id, version, file, name, summary}` per entry.
  A record's `conformsTo[]` block names entries here by `id` + `version`.
- `<standard-id>/<version>.yaml` - one file per standard version, `{id, version, name, authority, sourceUrl, notes, fields[], mapping[]}`:
  - `fields` describes the STANDARD's own field set (name, type, required, description) - a summary for readers, not a restatement of the entire external specification.
  - `mapping` is the part apps actually use: `{keyPath, field, transform?}` entries saying which DogTag record keyPath (specs/schemas/dogtag.vaccination.v1.schema.json, specs/schemas/leaf-dictionary.v1.json) corresponds to which field of the external standard, and how to convert between them when they are not a direct 1:1 copy.

## How a record's `conformsTo` refers here

A vaccination record's UNCOMMITTED envelope block (specs/leaf-commitment.md section 16) carries:

```
conformsTo: [{standard: "<id>", version: "<version>"}, ...]
```

Each entry names one file in this directory (`<id>/<version>.yaml`) the record's data satisfies, in the issuer's own judgment, at the time of issuance.
This is a CLAIM, not a cryptographic commitment: `conformsTo` sits in the record's uncommitted block precisely because it is descriptive metadata about the data, never itself part of the data the Merkle root commits to (specs/leaf-commitment.md section 16 states this explicitly - the committed leaves are `credentialSchema.id`/`credentialSchema.version`, the DogTag registry schema the record was actually issued against, which is a completely independent axis from which external standards its field values happen to also satisfy).
A record with an empty or absent `conformsTo` is unaffected either way: the DogTag-native `credentialSchema.id` binding is what a DogTag verifier checks, and no verifier in this protocol ever consults `conformsTo` to decide validity.

Nothing stops a single record from naming more than one entry - a record built to `dogtag.vaccination.v1` with FHIR-aligned field names, using a product covered by both NASPHV Form 51 and the EU passport model, can legitimately claim all three.

## How an app uses `mapping` to render or export

A DogTag-native app (the vet portal, the mobile app) never needs this directory to display or verify a record - it already knows `dogtag.vaccination.v1`'s own keyPaths directly.
This directory's `mapping` exists for the OTHER direction: an app that wants to render a record as, or export it into, one of these external standards' own shape (print a NASPHV Form 51 certificate, populate a FHIR Immunization resource, fill an EU passport page) looks up the standard's file by the record's `conformsTo` entry, then walks `mapping` to find which DogTag keyPath fills which of the standard's own fields, applying `transform` where the two are not a direct 1:1 copy.
A `mapping` entry whose `field` is `(none - see notes)` documents a DogTag keyPath the external standard has no equivalent for at all (or vice versa, a standard field this protocol's leaf set does not carry) - an exporter should omit that field rather than invent a value, and a reader should not treat the absence as an error.

## Versioning

Each `<standard-id>/<version>.yaml` describes ONE version of ONE external standard, pinned by its own `version` field and `sourceUrl`.
A future revision of an external standard (e.g. a new EU Regulation superseding 577/2013) is a NEW file (`<standard-id>/<new-version>.yaml`, a new `index.yaml` entry), never an edit to a published file - the same "never mutate a published identifier" discipline `specs/schemas/README.md` applies to `$id`s applies here to `(id, version)` pairs, for the identical reason: a record that already cites a given `(id, version)` in its `conformsTo` must go on meaning exactly what it meant at issuance.

## Relationship to `specs/schemas/leaf-dictionary.v1.json` and `dogtag.vaccination.v1.schema.json`

The FHIR-aligned field names `dogtag.vaccination.v1.schema.json` uses for its new (non-rabies-legacy) keyPaths - `targetDisease`, `targetDiseaseCode`, `route`, `site`, `doseQuantity`, `vaccineExpirationDate` - were chosen BECAUSE of `hl7-fhir-immunization/r4.yaml`'s own field names (WP4.14 plan section 8's research), so that mapping is close to the identity function by design.
The pre-existing rabies keyPaths (`vaccineProductName`, `vaccineProductCode`, `vaccineManufacturer`, `batchLotNumber`, `vaccinationDate`, `validFrom`, `validUntil`, `nextDueDate`, `series`, `authorizedVet`) are unchanged from `dogtag.rabies-vaccination.v1` (kept for interop with that already-shipped schema) and map cleanly to NASPHV Form 51 and the EU passport model, both of which predate this protocol's own naming and were the reason those keyPaths were named the way they were in the first place.
None of this - the keyPath names, the schema, or this directory - changes anything about how a record's leaves are hashed or its root computed; see specs/leaf-commitment.md for that.
