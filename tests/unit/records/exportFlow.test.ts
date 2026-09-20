import {describe, expect, it} from "vitest";
import {listExportableRecordFields} from "@/lib/records/exportFlow";
import {buildVaccinationRecord, type VaccinationRecordContext, type VaccinationRecordForm} from "@/lib/records/build";

/**
 * WP4.17 phase A defect D1 (vet part): the seven-keyPath records non-maskable set (WP4.14
 * decision 5) was pinned by no executing test on the vet side - deleting "issuer.operator" from
 * `RECORD_NON_MASKABLE_KEY_PATHS` (`@dogtag/standard`) survived the full vet suite, because the
 * one existing check that looks anywhere near this (`tests/unit/records/build.test.ts`'s "always
 * includes every one of the 7 non-maskable keyPaths") iterates the constant itself - shrink the
 * constant and the loop just checks fewer keyPaths, never failing.
 *
 * This is the export flow's OWN "where it locks it" check instead: `listExportableRecordFields`
 * (`src/lib/records/exportFlow.ts`) is the function that marks a leaf `locked: true` for the
 * staff-facing field picker - "the picker renders these as locked, not merely a checkbox staff
 * could uncheck", per that function's own doc comment - and every expectation below is a LITERAL,
 * hardcoded keyPath list, never a re-import or re-derivation of the constant under test, so a
 * shrunk (or grown, or reordered) constant changes `locked` for a keyPath this file still checks
 * by name.
 */

const CONTEXT: VaccinationRecordContext = {
  dogTagIdField: "424242",
  issuer: {
    chainId: 135,
    contract: "0x86d9ac6c094783e6a27d3bdbb6ef868060256c75",
    operator: "0x1575c525000000000000000000000000005cda",
    name: "Riverside Vet Clinic",
    domain: "riverside.example",
  },
  authorizedVet: "Dr. Jane Tan, DVM",
};

const FORM: VaccinationRecordForm = {
  targetDisease: "rabies",
  targetDiseaseCode: "RABIES-SNOMED-123",
  vaccineProductName: "Rabvac 3",
  vaccineProductCode: "USDA-999",
  vaccineManufacturer: "Boehringer Ingelheim",
  batchLotNumber: "LOT-998",
  vaccinationDate: "2026-09-01",
  validFrom: "2026-09-01",
  validUntil: "2027-09-01",
  nextDueDate: "2027-09-01",
  series: "primary",
  route: "subcutaneous",
  site: "left flank",
  doseQuantity: "1.50",
  vaccineExpirationDate: "2027-01-01",
};

describe("listExportableRecordFields - the seven-keyPath non-maskable set (WP4.17 D1)", () => {
  it("locks exactly the seven decided keyPaths, by literal name, and nothing else", () => {
    const {leaves} = buildVaccinationRecord(FORM, CONTEXT);
    const fields = listExportableRecordFields(leaves);
    const lockedKeyPaths = fields.filter((f) => f.locked).map((f) => f.keyPath);
    const unlockedKeyPaths = fields.filter((f) => !f.locked).map((f) => f.keyPath);

    // The literal seven, spelled out - never `[...RECORD_NON_MASKABLE_KEY_PATHS]` or any other
    // re-read of the constant under test.
    expect(lockedKeyPaths.sort()).toEqual(
      [
        "credentialSubject.dogTagId",
        "recordType",
        "credentialSchema.id",
        "credentialSchema.version",
        "issuer.chainId",
        "issuer.contract",
        "issuer.operator",
      ].sort(),
    );
    expect(lockedKeyPaths).toHaveLength(7);

    // Every other leaf this fixture carries must be maskable - locked by name above, unlocked by
    // name here, so a keyPath cannot silently vanish from both lists at once.
    expect(unlockedKeyPaths.sort()).toEqual(
      [
        "issuer.name",
        "issuer.domain",
        "authorizedVet",
        "targetDisease",
        "targetDiseaseCode",
        "vaccineProductName",
        "vaccineProductCode",
        "vaccineManufacturer",
        "batchLotNumber",
        "vaccinationDate",
        "validFrom",
        "validUntil",
        "nextDueDate",
        "series",
        "route",
        "site",
        "doseQuantity",
        "vaccineExpirationDate",
      ].sort(),
    );
  });

  it("locks issuer.operator by name specifically - the WP4.17 D1 bite (deleting it from the constant must flip this to false)", () => {
    const {leaves} = buildVaccinationRecord(FORM, CONTEXT);
    const fields = listExportableRecordFields(leaves);
    const operatorField = fields.find((f) => f.keyPath === "issuer.operator");
    expect(operatorField?.locked).toBe(true);
  });
});
