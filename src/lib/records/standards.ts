/**
 * The known-standard whitelist for a `RecordArtifact`'s UNCOMMITTED `conformsTo[]` block
 * (specs/leaf-commitment.md section 16) - a hand-maintained mirror of `protocol/specs/standards/
 * index.yaml`'s own `standards[]` list (advisor review finding on WP4.14V's V3 checkpoint: the
 * vendored registry had zero consumers in this wave; `conformsTo` was always `[]`).
 *
 * `conformsTo` is descriptive metadata only - `index.yaml`'s own header is explicit that "nothing in
 * packages/dogtag-standard-ts ... parses, validates, or enforces any of it" - so this app does not
 * (and, per that same header, never should) attempt to derive whether a record's data actually
 * SATISFIES a standard's field requirements. Instead, the certifying vet marks which standard(s) the
 * record they are issuing was filled out to satisfy (plan section 11.2 V4's issuance form), exactly
 * the same way a real paper NASPHV Form 51 or EU pet passport page is the vet's own attestation, not
 * a computed fact - this module exists only to reject a claim naming a standard/version pair this
 * protocol version does not recognize at all.
 *
 * A plain hand-encoded constant, not a runtime YAML parse: no `yaml`/`js-yaml` dependency exists in
 * this app (checked at the time this was written), and nothing else here reads `specs/standards/`
 * dynamically either - keep this list in sync by hand on any future protocol vendor sync that touches
 * `specs/standards/index.yaml` (`protocol/PROVENANCE.md`'s own rebuild-steps section is the right
 * place to note it changed).
 */
export interface KnownStandard {
  id: string;
  version: string;
  name: string;
}

export const KNOWN_RECORD_STANDARDS: readonly KnownStandard[] = [
  {id: "hl7-fhir-immunization", version: "r4", name: "HL7 FHIR Immunization (R4)"},
  {id: "nasphv-form51", version: "2007", name: "NASPHV Form 51 (Rabies Vaccination Certificate)"},
  {id: "eu-pet-passport", version: "577-2013-annex-iii-v", name: "EU Pet Passport (Regulation 577/2013, Annex III-V)"},
] as const;

export function isKnownRecordStandard(standard: string, version: string): boolean {
  return KNOWN_RECORD_STANDARDS.some((s) => s.id === standard && s.version === version);
}
