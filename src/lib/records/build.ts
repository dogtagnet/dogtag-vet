import {randomBytes} from "node:crypto";
import {TypeTag, hashLeaf, buildMerkle, canonicalDecimal, fromHex32, hexToBytes, scalarFromPacked, toHex32, type OpenedLeaf} from "@dogtag/standard";

/**
 * The pure vaccination-record leaf builder (plan section 11.2 item V2) - the record-artifact
 * sibling of `lib/mint/identityLeaves.ts`'s `buildIdentityLeaves`. No I/O, no mongoose, no chain
 * reads: every value it needs arrives already resolved in `context` (the caller - `lib/records/
 * artifact.ts`'s issuance flow, plan section 11.2 V3 - is the one place chain settings, clinic
 * business-profile fields, and the connected operator wallet actually get read).
 *
 * There is no generic `flatten()`/`schema.ts` dispatch for `VACCINATION` to call into (unlike a
 * profile tree's known record types): `specs/schemas/dogtag.vaccination.v1.schema.json`'s own
 * header states plainly that this record type has no `schema.ts` branch at all - "no code validates
 * that document shape directly" - so the field-to-keyPath mapping below is hand-written, exactly
 * the same way `buildIdentityLeaves` hand-maps `OwnerIdentity` fields; there is nothing generic to
 * reuse for a record type this deliberately narrow.
 */

export const VACCINATION_SCHEMA_ID = "https://dogtag.io/schemas/vaccination/v1";
/** Mirrors `dogtag.vaccination.v1.schema.json`'s own top-level `"version"` field exactly - not
 * const-pinned by that schema's `credentialSchema.version` property (an additive minor tick keeps
 * the same `$id` - see that schema's own justification), so this constant is this app's own choice
 * of which version its issuance flow currently targets, not a value the registry forces on it. */
export const VACCINATION_SCHEMA_VERSION = "1.0.0";

export interface VaccinationRecordForm {
  targetDisease: string;
  targetDiseaseCode?: string;
  vaccineProductName: string;
  vaccineProductCode?: string;
  vaccineManufacturer: string;
  batchLotNumber: string;
  /** ISO calendar date (`YYYY-MM-DD`) - the clinical date leaf (specs/leaf-commitment.md section
   * 16: dates, not block numbers, are the leaf). */
  vaccinationDate: string;
  validFrom: string;
  validUntil: string;
  nextDueDate?: string;
  series?: "primary" | "booster";
  route?: string;
  site?: string;
  /** A canonical-or-plain decimal string, e.g. `"1"` or `"0.5"` - passed through `canonicalDecimal`
   * below, which throws on anything that is not a valid decimal (WP4.14 plan section 1's Decimal
   * tag; never a native float). */
  doseQuantity?: string;
  vaccineExpirationDate?: string;
}

export interface VaccinationRecordContext {
  /** Decimal-string convention throughout this app - the pet's on-chain `dogTagIdField`. */
  dogTagIdField: string;
  issuer: {
    chainId: number;
    contract: string;
    operator: string;
    /** From the clinic's business profile (`ClinicSettings.businessProfile`) - optional, maskable. */
    name?: string;
    /** From the clinic's business profile - optional, maskable. */
    domain?: string;
  };
  /** The certifying practitioner's composed name + accreditation (WP4.13's vet display-name
   * split) - optional, maskable. Distinct from `issuer.operator` (the wallet) and `issuer.contract`
   * (the clinic's on-chain contract). */
  authorizedVet?: string;
}

interface LeafSpec {
  keyPath: string;
  tag: TypeTag;
  value: string;
}

/**
 * Pure derivation of WHICH leaves this record carries and their (tag, value) - no salts yet.
 * Exported so a test can assert the exact field derivation without caring about the per-call
 * randomness `saltRecordLeaves` introduces. Order: the seven non-maskable leaves first (context-
 * derived, always present - see below), then the optional context-derived leaves, then the
 * clinical/FHIR-aligned leaves in `specs/schemas/leaf-dictionary.v1.json`'s own declared order.
 *
 * The seven keyPaths `RECORD_NON_MASKABLE_KEY_PATHS` (`@dogtag/standard`) names are ALWAYS present
 * here, by construction - every one of them is derived from `context`, never from the (optional)
 * form, so there is no way to call this function and end up missing one.
 */
export function deriveRecordLeafSpecs(form: VaccinationRecordForm, context: VaccinationRecordContext): LeafSpec[] {
  const specs: LeafSpec[] = [
    {keyPath: "credentialSubject.dogTagId", tag: TypeTag.String, value: context.dogTagIdField},
    {keyPath: "recordType", tag: TypeTag.String, value: "VACCINATION"},
    {keyPath: "credentialSchema.id", tag: TypeTag.String, value: VACCINATION_SCHEMA_ID},
    {keyPath: "credentialSchema.version", tag: TypeTag.String, value: VACCINATION_SCHEMA_VERSION},
    {keyPath: "issuer.chainId", tag: TypeTag.Integer, value: String(context.issuer.chainId)},
    {keyPath: "issuer.contract", tag: TypeTag.String, value: context.issuer.contract.toLowerCase()},
    {keyPath: "issuer.operator", tag: TypeTag.String, value: context.issuer.operator.toLowerCase()},
  ];

  if (context.issuer.name?.trim()) {
    specs.push({keyPath: "issuer.name", tag: TypeTag.String, value: context.issuer.name.trim()});
  }
  if (context.issuer.domain?.trim()) {
    specs.push({keyPath: "issuer.domain", tag: TypeTag.String, value: context.issuer.domain.trim()});
  }
  if (context.authorizedVet?.trim()) {
    specs.push({keyPath: "authorizedVet", tag: TypeTag.String, value: context.authorizedVet.trim()});
  }

  specs.push({keyPath: "targetDisease", tag: TypeTag.String, value: form.targetDisease.trim()});
  if (form.targetDiseaseCode?.trim()) {
    specs.push({keyPath: "targetDiseaseCode", tag: TypeTag.String, value: form.targetDiseaseCode.trim()});
  }
  specs.push({keyPath: "vaccineProductName", tag: TypeTag.String, value: form.vaccineProductName.trim()});
  if (form.vaccineProductCode?.trim()) {
    specs.push({keyPath: "vaccineProductCode", tag: TypeTag.String, value: form.vaccineProductCode.trim()});
  }
  specs.push({keyPath: "vaccineManufacturer", tag: TypeTag.String, value: form.vaccineManufacturer.trim()});
  specs.push({keyPath: "batchLotNumber", tag: TypeTag.String, value: form.batchLotNumber.trim()});
  specs.push({keyPath: "vaccinationDate", tag: TypeTag.String, value: form.vaccinationDate.trim()});
  specs.push({keyPath: "validFrom", tag: TypeTag.String, value: form.validFrom.trim()});
  specs.push({keyPath: "validUntil", tag: TypeTag.String, value: form.validUntil.trim()});
  if (form.nextDueDate?.trim()) {
    specs.push({keyPath: "nextDueDate", tag: TypeTag.String, value: form.nextDueDate.trim()});
  }
  if (form.series) {
    specs.push({keyPath: "series", tag: TypeTag.String, value: form.series});
  }
  if (form.route?.trim()) {
    specs.push({keyPath: "route", tag: TypeTag.String, value: form.route.trim()});
  }
  if (form.site?.trim()) {
    specs.push({keyPath: "site", tag: TypeTag.String, value: form.site.trim()});
  }
  if (form.doseQuantity?.trim()) {
    // leaf-dictionary.v1.json tags doseQuantity Decimal - canonicalDecimal throws on anything that
    // is not a valid decimal string, closing the "never a native float" rule at the leaf boundary.
    specs.push({keyPath: "doseQuantity", tag: TypeTag.Decimal, value: canonicalDecimal(form.doseQuantity.trim())});
  }
  if (form.vaccineExpirationDate?.trim()) {
    specs.push({keyPath: "vaccineExpirationDate", tag: TypeTag.String, value: form.vaccineExpirationDate.trim()});
  }

  return specs;
}

/**
 * Attaches a FRESH, server-generated 16-byte salt to each spec - the only randomness point in this
 * module, mirroring `buildIdentityLeaves`'s own `` `0x${randomBytes(16).toString("hex")}` `` exactly
 * (32 lowercase hex characters after the prefix). Never client-supplied, never reused across leaves
 * or records - `@dogtag/standard`'s verifier now REJECTS a non-hex/odd-length `saltHex` outright
 * (fix round 1 D2), so this is also the one place a malformed salt could ever originate from in
 * this app, and it never will: `randomBytes(16).toString("hex")` is always exactly 32 lowercase hex
 * characters, by construction.
 */
export function saltRecordLeaves(specs: LeafSpec[]): OpenedLeaf[] {
  return specs.map((spec) => ({
    keyPath: spec.keyPath,
    saltHex: `0x${randomBytes(16).toString("hex")}`,
    tag: spec.tag,
    value: spec.value,
  }));
}

/** Composes the two functions above - the production entry point for "form + context -> salted
 * leaves, ready to hash and fold into a root". Non-deterministic (fresh salts every call), by
 * design - see `computeRecordRoot` below for the deterministic half tests can pin exactly. */
export function buildRecordArtifactLeaves(form: VaccinationRecordForm, context: VaccinationRecordContext): OpenedLeaf[] {
  return saltRecordLeaves(deriveRecordLeafSpecs(form, context));
}

/**
 * Recompute ONE leaf's hash from its posted opening - `hashLeaf` composed with the frozen
 * `scalarFromPacked`/`hexToBytes`, never a stored value trusted bare. Exported for `lib/records/
 * exportFlow.ts` (plan section 11.2 V5) to reuse when it recomputes fresh `obfuscatedLeafHashes`
 * entries for a masked export - the same "never trust a stored hash for a leaf about to be masked,
 * only ever recompute it from the opening" rule `exportFlow.ts`'s own `recomputeLeafHash` already
 * follows for tags (a third, deliberate transcription of the same composition, per `recordArtifact.
 * ts`'s own header on why this repository prefers that over a shared import for this class of code).
 */
export function recomputeRecordLeafHash(leaf: OpenedLeaf): string {
  return toHex32(hashLeaf(leaf.keyPath, hexToBytes(leaf.saltHex), scalarFromPacked(leaf.tag, leaf.value)));
}

/**
 * `hashLeaf` + `buildMerkle` composition ONLY - the vendored FROZEN primitives, never
 * reimplemented here (this file introduces no new hashing/encoding/merkle rule of its own, exactly
 * like `recordArtifact.ts`'s own header states for its sibling `recomputeLeaf`). Takes any
 * `OpenedLeaf[]`, not just this module's own output - so a test can feed it a FIXED, known leaf set
 * (a `specs/leaf-commitment-vectors.json` `recordArtifactVectors` fixture, verbatim) and assert the
 * output equals that vector's own `root_hex`, independent of this module's own (random-salted)
 * derivation logic.
 *
 * Only ever called with EVERY leaf fully disclosed (this module never produces a masked leaf set -
 * masking is an EXPORT-time concern, plan section 11.2 V5, which folds `obfuscatedLeafHashes` in
 * separately via `lib/records/exportFlow.ts`); see that module for the masked equivalent.
 */
export function computeRecordRoot(leaves: OpenedLeaf[]): string {
  const {root} = buildMerkle(leaves.map(recomputeRecordLeafHash).map(fromHex32));
  return toHex32(root);
}

/** The one call site V3's issuance route needs: build the leaves AND their root together, so the
 * two can never be computed from two different leaf sets by accident. */
export function buildVaccinationRecord(
  form: VaccinationRecordForm,
  context: VaccinationRecordContext,
): {leaves: OpenedLeaf[]; root: string} {
  const leaves = buildRecordArtifactLeaves(form, context);
  return {leaves, root: computeRecordRoot(leaves)};
}
