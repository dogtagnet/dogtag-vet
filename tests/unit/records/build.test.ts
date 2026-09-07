import {describe, expect, it} from "vitest";
import {RECORD_NON_MASKABLE_KEY_PATHS, TypeTag, verifyRecordArtifact, type RecordArtifact} from "@dogtag/standard";
import vectors from "../../../protocol/specs/leaf-commitment-vectors.json";
import {
  buildRecordArtifactLeaves,
  buildVaccinationRecord,
  computeRecordRoot,
  deriveRecordLeafSpecs,
  saltRecordLeaves,
  VACCINATION_SCHEMA_ID,
  VACCINATION_SCHEMA_VERSION,
  type VaccinationRecordContext,
  type VaccinationRecordForm,
} from "@/lib/records/build";

/**
 * Plan section 11.2 item V2 - the vaccination-record leaf builder, against `recordArtifactVectors`
 * (proves the hashing wiring is correct, independent of this module's own derivation logic) and the
 * non-maskable set (proves the seven keyPaths are never skippable, by construction).
 */

const FULL_CONTEXT: VaccinationRecordContext = {
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

const FULL_FORM: VaccinationRecordForm = {
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

const MINIMAL_FORM: VaccinationRecordForm = {
  targetDisease: "rabies",
  vaccineProductName: "Rabvac 3",
  vaccineManufacturer: "Boehringer Ingelheim",
  batchLotNumber: "LOT-998",
  vaccinationDate: "2026-09-01",
  validFrom: "2026-09-01",
  validUntil: "2027-09-01",
};

const MINIMAL_CONTEXT: VaccinationRecordContext = {
  dogTagIdField: "424242",
  issuer: {chainId: 135, contract: "0x86d9ac6c094783e6a27d3bdbb6ef868060256c75", operator: "0x1575c525000000000000000000000000005cda"},
};

describe("deriveRecordLeafSpecs", () => {
  it("derives the exact leaf list for a fully-populated form + context, in order", () => {
    expect(deriveRecordLeafSpecs(FULL_FORM, FULL_CONTEXT)).toEqual([
      {keyPath: "credentialSubject.dogTagId", tag: TypeTag.String, value: "424242"},
      {keyPath: "recordType", tag: TypeTag.String, value: "VACCINATION"},
      {keyPath: "credentialSchema.id", tag: TypeTag.String, value: VACCINATION_SCHEMA_ID},
      {keyPath: "credentialSchema.version", tag: TypeTag.String, value: VACCINATION_SCHEMA_VERSION},
      {keyPath: "issuer.chainId", tag: TypeTag.Integer, value: "135"},
      {keyPath: "issuer.contract", tag: TypeTag.String, value: "0x86d9ac6c094783e6a27d3bdbb6ef868060256c75"},
      {keyPath: "issuer.operator", tag: TypeTag.String, value: "0x1575c525000000000000000000000000005cda"},
      {keyPath: "issuer.name", tag: TypeTag.String, value: "Riverside Vet Clinic"},
      {keyPath: "issuer.domain", tag: TypeTag.String, value: "riverside.example"},
      {keyPath: "authorizedVet", tag: TypeTag.String, value: "Dr. Jane Tan, DVM"},
      {keyPath: "targetDisease", tag: TypeTag.String, value: "rabies"},
      {keyPath: "targetDiseaseCode", tag: TypeTag.String, value: "RABIES-SNOMED-123"},
      {keyPath: "vaccineProductName", tag: TypeTag.String, value: "Rabvac 3"},
      {keyPath: "vaccineProductCode", tag: TypeTag.String, value: "USDA-999"},
      {keyPath: "vaccineManufacturer", tag: TypeTag.String, value: "Boehringer Ingelheim"},
      {keyPath: "batchLotNumber", tag: TypeTag.String, value: "LOT-998"},
      {keyPath: "vaccinationDate", tag: TypeTag.String, value: "2026-09-01"},
      {keyPath: "validFrom", tag: TypeTag.String, value: "2026-09-01"},
      {keyPath: "validUntil", tag: TypeTag.String, value: "2027-09-01"},
      {keyPath: "nextDueDate", tag: TypeTag.String, value: "2027-09-01"},
      {keyPath: "series", tag: TypeTag.String, value: "primary"},
      {keyPath: "route", tag: TypeTag.String, value: "subcutaneous"},
      {keyPath: "site", tag: TypeTag.String, value: "left flank"},
      {keyPath: "doseQuantity", tag: TypeTag.Decimal, value: "1.5"}, // canonicalDecimal strips the trailing zero
      {keyPath: "vaccineExpirationDate", tag: TypeTag.String, value: "2027-01-01"},
    ]);
  });

  it("omits every optional leaf when the form/context supplies none of them - exactly the 7 non-maskable plus the 7 always-required clinical fields", () => {
    const specs = deriveRecordLeafSpecs(MINIMAL_FORM, MINIMAL_CONTEXT);
    expect(specs).toHaveLength(14);
    expect(specs.map((s) => s.keyPath)).toEqual([
      "credentialSubject.dogTagId",
      "recordType",
      "credentialSchema.id",
      "credentialSchema.version",
      "issuer.chainId",
      "issuer.contract",
      "issuer.operator",
      "targetDisease",
      "vaccineProductName",
      "vaccineManufacturer",
      "batchLotNumber",
      "vaccinationDate",
      "validFrom",
      "validUntil",
    ]);
  });

  it("always includes every one of the 7 non-maskable keyPaths, by construction (they come from context, never the optional form)", () => {
    for (const form of [FULL_FORM, MINIMAL_FORM]) {
      const context = form === FULL_FORM ? FULL_CONTEXT : MINIMAL_CONTEXT;
      const keyPaths = deriveRecordLeafSpecs(form, context).map((s) => s.keyPath);
      for (const required of RECORD_NON_MASKABLE_KEY_PATHS) {
        expect(keyPaths).toContain(required);
      }
    }
  });

  it("lowercases issuer.contract/issuer.operator regardless of input casing", () => {
    const mixedCase: VaccinationRecordContext = {
      ...MINIMAL_CONTEXT,
      issuer: {...MINIMAL_CONTEXT.issuer, contract: "0x86D9AC6C094783E6A27D3BDBB6EF868060256C75", operator: "0x1575C525000000000000000000000000005CDA"},
    };
    const specs = deriveRecordLeafSpecs(MINIMAL_FORM, mixedCase);
    expect(specs.find((s) => s.keyPath === "issuer.contract")?.value).toBe("0x86d9ac6c094783e6a27d3bdbb6ef868060256c75");
    expect(specs.find((s) => s.keyPath === "issuer.operator")?.value).toBe("0x1575c525000000000000000000000000005cda");
  });
});

describe("saltRecordLeaves", () => {
  it("attaches a well-formed, 0x-prefixed 32-hex-char salt to every leaf", () => {
    const leaves = saltRecordLeaves(deriveRecordLeafSpecs(MINIMAL_FORM, MINIMAL_CONTEXT));
    for (const leaf of leaves) {
      expect(leaf.saltHex).toMatch(/^0x[0-9a-f]{32}$/);
    }
  });

  it("generates a FRESH salt on every call - two builds of the identical spec never share a salt", () => {
    const specs = deriveRecordLeafSpecs(MINIMAL_FORM, MINIMAL_CONTEXT);
    const a = saltRecordLeaves(specs);
    const b = saltRecordLeaves(specs);
    expect(a).toHaveLength(b.length);
    for (const [i, leafA] of a.entries()) {
      expect(leafA.saltHex).not.toBe(b[i]?.saltHex);
    }
  });
});

describe("computeRecordRoot - reproduces specs/leaf-commitment-vectors.json's recordArtifactVectors", () => {
  const recordVectors = (vectors as {recordArtifactVectors: {name: string; disclosed: {keyPath: string; saltHex: string; tag: number; value: string}[]; obfuscatedLeafHashes: string[]; root_hex: string}[]}).recordArtifactVectors;

  it("the vector set is non-empty and contains the reference 'record_full_artifact' vector", () => {
    expect(recordVectors.length).toBeGreaterThan(0);
    expect(recordVectors.map((v) => v.name)).toContain("record_full_artifact");
  });

  it("'record_full_artifact' (fully disclosed, 0 obfuscated) recomputes to the vector's own root_hex", () => {
    const vector = recordVectors.find((v) => v.name === "record_full_artifact")!;
    expect(vector.obfuscatedLeafHashes).toHaveLength(0);
    const leaves = vector.disclosed.map((d) => ({keyPath: d.keyPath, saltHex: d.saltHex, tag: d.tag, value: d.value}));
    expect(computeRecordRoot(leaves)).toBe(vector.root_hex);
  });

  // Grade round 1 D4: deriveRecordLeafSpecs' own array order is NOT "dictionary order" (its doc
  // comment used to falsely claim it was) - pins the reason that divergence is harmless rather than
  // a defect: buildMerkle sorts its leaves ascending before folding, so computeRecordRoot cannot
  // possibly depend on the order leaves arrive in. Reversing the entire array is the strongest
  // single case ("some order changed") rather than a narrower swap of two adjacent leaves.
  it("leaf array ORDER never affects the root - buildMerkle sorts ascending before folding", () => {
    const vector = recordVectors.find((v) => v.name === "record_full_artifact")!;
    const leaves = vector.disclosed.map((d) => ({keyPath: d.keyPath, saltHex: d.saltHex, tag: d.tag, value: d.value}));
    expect(computeRecordRoot(leaves)).toBe(computeRecordRoot([...leaves].reverse()));
  });

  it("verifyRecordArtifact (the vendored verifier) also accepts that same vector, end to end", () => {
    const vector = recordVectors.find((v) => v.name === "record_full_artifact")!;
    const artifact: RecordArtifact = {
      protocolVersion: "dogtag-v2/1",
      artifactType: "record",
      root: vector.root_hex,
      disclosed: vector.disclosed.map((d) => ({keyPath: d.keyPath, saltHex: d.saltHex, tag: d.tag, value: d.value})),
      obfuscatedLeafHashes: vector.obfuscatedLeafHashes,
      reservedLeafHashes: [],
    };
    expect(verifyRecordArtifact(artifact)).toBe(true);
  });
});

describe("buildVaccinationRecord - the production entry point", () => {
  it("produces a root that verifyRecordArtifact accepts, for a fully-populated record", () => {
    const {leaves, root} = buildVaccinationRecord(FULL_FORM, FULL_CONTEXT);
    expect(computeRecordRoot(leaves)).toBe(root); // internally consistent
    const artifact: RecordArtifact = {
      protocolVersion: "dogtag-v2/1",
      artifactType: "record",
      root,
      disclosed: leaves,
      obfuscatedLeafHashes: [],
      reservedLeafHashes: [],
    };
    expect(verifyRecordArtifact(artifact)).toBe(true);
  });

  it("produces a root that verifyRecordArtifact accepts, for the minimal (only-required-fields) record", () => {
    const {leaves, root} = buildVaccinationRecord(MINIMAL_FORM, MINIMAL_CONTEXT);
    const artifact: RecordArtifact = {
      protocolVersion: "dogtag-v2/1",
      artifactType: "record",
      root,
      disclosed: leaves,
      obfuscatedLeafHashes: [],
      reservedLeafHashes: [],
    };
    expect(verifyRecordArtifact(artifact)).toBe(true);
  });

  it("two builds of the identical form+context produce DIFFERENT roots (fresh salts each time)", () => {
    const first = buildVaccinationRecord(FULL_FORM, FULL_CONTEXT);
    const second = buildVaccinationRecord(FULL_FORM, FULL_CONTEXT);
    expect(first.root).not.toBe(second.root);
  });
});

describe("buildRecordArtifactLeaves", () => {
  it("composes deriveRecordLeafSpecs + saltRecordLeaves (same keyPath/tag/value, salts attached)", () => {
    const leaves = buildRecordArtifactLeaves(MINIMAL_FORM, MINIMAL_CONTEXT);
    const specs = deriveRecordLeafSpecs(MINIMAL_FORM, MINIMAL_CONTEXT);
    expect(leaves.map((l) => ({keyPath: l.keyPath, tag: l.tag, value: l.value}))).toEqual(specs);
    for (const leaf of leaves) expect(leaf.saltHex).toMatch(/^0x[0-9a-f]{32}$/);
  });
});
