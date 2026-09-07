/**
 * Human-readable labels for a VACCINATION record's own leaf keyPaths (plan section 11.2 V4's detail
 * view: "all leaves via a dynamic key/value renderer with dictionary labels") - a DISPLAY concern
 * only, layered on top of (never a replacement for) the vendored `specs/schemas/leaf-dictionary.v1
 * .json`, whose own entries carry `tags`/`requirement`/protocol-implementer `notes`, not UI copy.
 * Keyed by every keyPath `lib/records/build.ts`'s `deriveRecordLeafSpecs` can ever produce.
 *
 * Deliberately not exhaustive against every keyPath a FUTURE record type might ever add -
 * `recordLeafLabel` below falls back to a generic title-cased rendering of the keyPath's own last
 * dotted segment for anything not listed here, so an unrecognized leaf still renders (just less
 * prettily) rather than being silently dropped from the detail view - the "dynamic" half of the
 * checklist's own wording.
 */
export const RECORD_LEAF_LABELS: Record<string, string> = {
  "credentialSubject.dogTagId": "DogTag ID",
  recordType: "Record Type",
  "credentialSchema.id": "Schema",
  "credentialSchema.version": "Schema Version",
  "issuer.chainId": "Chain ID",
  "issuer.contract": "Issuing Contract",
  "issuer.operator": "Issuing Operator Wallet",
  "issuer.name": "Clinic Name",
  "issuer.domain": "Clinic Domain",
  authorizedVet: "Authorized Veterinarian",
  targetDisease: "Target Disease",
  targetDiseaseCode: "Target Disease Code",
  vaccineProductName: "Vaccine Product",
  vaccineProductCode: "Vaccine Product Code",
  vaccineManufacturer: "Manufacturer",
  batchLotNumber: "Batch / Lot Number",
  vaccinationDate: "Vaccination Date",
  validFrom: "Valid From",
  validUntil: "Valid Until",
  nextDueDate: "Next Due Date",
  series: "Series",
  route: "Route",
  site: "Site",
  doseQuantity: "Dose Quantity",
  vaccineExpirationDate: "Vaccine Expiration Date",
};

/** The keyPaths above that are plain calendar dates (`YYYY-MM-DD`, no time-of-day) - rendered
 * through `lib/records/validity.ts`'s `formatIsoCalendarDate` (pinned to UTC, never a day-shift
 * risk), never through a clinic-timezone-aware instant formatter, which these values are not. */
export const RECORD_CALENDAR_DATE_KEY_PATHS: ReadonlySet<string> = new Set([
  "vaccinationDate",
  "validFrom",
  "validUntil",
  "nextDueDate",
  "vaccineExpirationDate",
]);

const SERIES_VALUE_LABELS: Record<string, string> = {primary: "Primary", booster: "Booster"};

/** Falls back to a generic title-cased rendering of the keyPath's own last dotted segment for
 * anything not in the map above. */
export function recordLeafLabel(keyPath: string): string {
  const known = RECORD_LEAF_LABELS[keyPath];
  if (known) return known;
  const last = keyPath.split(".").pop() ?? keyPath;
  const spaced = last.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A leaf's raw `value` is always a plain string (the wire encoding - `RecordArtifactLeaf.value`);
 * this maps the few keyPaths whose value is itself a code (`series: "primary"`) onto a friendlier
 * display string. Every other keyPath's value already reads naturally as-is. */
export function recordLeafDisplayValue(keyPath: string, value: string): string {
  if (keyPath === "series") return SERIES_VALUE_LABELS[value] ?? value;
  return value;
}
