// Conformance gate for the S2 schema registry (specs/schemas/): pins packages/dogtag-standard-ts/src/
// schema.ts's validateSchema against the registry so the two cannot drift apart silently.
//
// Three things are asserted:
//   1. Every valid fixture passes BOTH validateSchema (code) and its record type's JSON Schema.
//   2. Every ENUMERATED violation case (below) is either caught by the JSON Schema itself, or is
//      named in that schema's x-validationRules.covers array - never neither. "Enumerated" is the
//      operative word: this is a pinned, hand-curated list of violation cases (schema.ts exports no
//      catalogue of its own violation messages to iterate mechanically against), so the claim this
//      file supports is "every case in this list is classified," not "every violation schema.ts can
//      ever produce is classified." The case count is asserted below so a future edit that silently
//      drops a case is caught.
//   3. Flattening every valid fixture (after converting it to the typed-scalar form flatten() expects,
//      driven ENTIRELY by specs/schemas/leaf-dictionary.v1.json) yields only keyPaths present in the
//      dictionary, each with an allowed TypeTag - proving the dictionary is sufficient to type every
//      field these fixtures carry, not merely that a hand-picked sample of it is correct.
import {describe, it, expect, beforeAll} from "vitest";
import {readFileSync, readdirSync} from "node:fs";
import {resolve} from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type {ValidateFunction} from "ajv";
import {validateSchema, DOGTAG_CONTEXT_URI, SchemaError} from "../src/schema.js";
import {flatten} from "../src/flatten.js";
import {TypeTag, type TypedScalar} from "../src/types.js";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCHEMAS_DIR = resolve(REPO_ROOT, "specs", "schemas");

interface XValidationRule {
  id: string;
  description: string;
  covers: string[];
}

interface RegistrySchema {
  $id: string;
  "x-validationRules"?: XValidationRule[];
  [k: string]: unknown;
}

const schemaFiles = readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith(".schema.json"));
const registrySchemas: RegistrySchema[] = schemaFiles.map((f) =>
  JSON.parse(readFileSync(resolve(SCHEMAS_DIR, f), "utf8")),
);

// strictTuples is relaxed deliberately: this registry's @context property is a genuinely open-ended
// tuple (a fixed first element, unlimited free-form trailing elements - the real shape of a W3C VC
// @context array), which ajv's strict-tuple heuristic flags as "not a well-formed tuple" even though
// it is exactly the intended, correct shape. Every other strict check stays on.
const ajv = new Ajv2020({strict: true, strictTuples: false, allErrors: true});
ajv.addKeyword({keyword: "version"});
ajv.addKeyword({keyword: "x-validationRules"});
for (const s of registrySchemas) ajv.addSchema(s);

function schemaFor(id: string): ValidateFunction {
  const v = ajv.getSchema(id);
  if (!v) throw new Error(`schema not registered: ${id}`);
  return v;
}

function rulesFor(id: string): XValidationRule[] {
  return registrySchemas.find((s) => s.$id === id)?.["x-validationRules"] ?? [];
}

/**
 * Assert `needle` is covered EXACTLY the way `expectAjvRejects` says it should be - not merely that
 * ajv rejected for SOME reason. Branching on the observed ajv result (as an earlier draft of this
 * helper did) would let a case pass for the wrong reason: a mutation that happens to also break an
 * unrelated structural constraint would short-circuit "caught structurally" without ever exercising
 * the x-validationRules lookup the delegated cases exist to prove. Asserting the expected branch
 * directly is what makes "structural" and "delegated" each a pinned, checked claim per case.
 */
function assertCoverage(schemaId: string, fixture: unknown, needle: string, expectAjvRejects: boolean) {
  const validate = schemaFor(schemaId);
  const ajvValid = validate(fixture);
  if (expectAjvRejects) {
    expect(ajvValid, `expected ${schemaId} to structurally reject ${JSON.stringify(needle)}, but it validated`).toBe(
      false,
    );
    return;
  }
  expect(
    ajvValid,
    `expected ${schemaId} to STILL accept ${JSON.stringify(needle)} (delegated to x-validationRules), but it rejected - errors: ${JSON.stringify((validate as ValidateFunction).errors)}`,
  ).toBe(true);
  const rules = rulesFor(schemaId);
  const covered = rules.some((r) => r.covers.some((c) => c.includes(needle) || needle.includes(c)));
  expect(
    covered,
    `violation ${JSON.stringify(needle)} passes ${schemaId} structurally but is not declared in its x-validationRules - registry/code drift`,
  ).toBe(true);
}

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

function expectViolation(c: Record<string, unknown>, needle: string): void {
  try {
    validateSchema(c);
    throw new Error(`expected validateSchema to throw containing ${JSON.stringify(needle)}`);
  } catch (e) {
    expect(e).toBeInstanceOf(SchemaError);
    expect((e as SchemaError).violations.join("\n")).toContain(needle);
  }
}

// ---- fixtures (self-contained; not imported from schema.test.ts/schema_conditional.test.ts so this
// file has no dependency on those files' internal shape) ----

function validRabies(): Record<string, unknown> {
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2", DOGTAG_CONTEXT_URI],
    type: ["VerifiableCredential", "RabiesVaccinationCertificate"],
    id: "urn:uuid:rabies-1",
    issuer: "did:web:vet.example",
    validFrom: "2024-02-01",
    validUntil: "2027-01-11",
    nextDueDate: "2027-01-11",
    credentialSchema: {id: "https://dogtag.io/schemas/rabies-vaccination/v1", type: "JsonSchema"},
    credentialStatus: {id: "https://dogtag.io/status/1", type: "DogTagStatus2025"},
    attestationType: "vaccination",
    signatureTrustTier: "licensed_vet",
    legalEffect: "evidentiary",
    legalBasisVersion: "EU-2013-576-v1",
    jurisdiction: "EU",
    recordType: "VACCINATION",
    vaccineProductCode: "USDA-PCN-12345",
    vaccineProductName: "Rabvac 3",
    vaccineManufacturer: "Boehringer Ingelheim",
    batchLotNumber: "LOT-998",
    vaccinationDate: "2024-01-11",
    authorizedVet: "did:web:vet.example#vet1",
    series: "primary",
    titer: {labId: "LAB-7", sampledAt: "2024-02-11", resultIUml: "0.7"},
    credentialSubject: {
      dogTagId: "dogtag:0xabc",
      dateOfBirth: "2023-09-01",
      microchip: {code: "985141006580319", standard: "ISO_11784_11785", implantDate: "2023-10-01"},
    },
  };
}

function validDogProfile(): Record<string, unknown> {
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2", DOGTAG_CONTEXT_URI],
    type: ["VerifiableCredential"],
    id: "urn:uuid:prof-1",
    issuer: "did:web:issuer.example",
    validFrom: "2024-01-01",
    credentialSchema: {id: "https://dogtag.io/schemas/dog-profile/v1", type: "JsonSchema"},
    credentialStatus: {id: "https://dogtag.io/status/1", type: "DogTagStatus2025"},
    attestationType: "generic",
    signatureTrustTier: "self_attested",
    legalEffect: "evidentiary",
    legalBasisVersion: "v1",
    jurisdiction: "EU",
    recordType: "DOG_PROFILE",
    credentialSubject: {
      dogTagId: "dogtag:0xprof",
      species: "dog",
      breedVbo: "VBO-123",
      breedLabel: "Labrador",
      sex: "female",
      neuterStatus: "spayed",
      dateOfBirth: "2022-05-01",
      ownerIdentity: {countryOfIdentification: "DE", identification: "ID-1", name: "Jane"},
      weightHistory: [{unit: "kg", value: "12.5", measuredOn: "2024-01-01"}],
    },
  };
}

function validServiceAttestation(): Record<string, unknown> {
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2", DOGTAG_CONTEXT_URI],
    type: ["VerifiableCredential", "ServiceAttestation"],
    id: "urn:uuid:svc-1",
    issuer: "did:web:trainer.example",
    validFrom: "2024-01-01",
    credentialSchema: {id: "https://dogtag.io/schemas/service-attestation/v1", type: "JsonSchema"},
    credentialStatus: {id: "https://dogtag.io/status/2", type: "DogTagStatus2025"},
    attestationType: "service",
    signatureTrustTier: "self_attested",
    legalEffect: "evidentiary",
    legalBasisVersion: "ADA-v1",
    jurisdiction: "US",
    recordType: "SERVICE_ATTESTATION",
    assistanceType: "service_dog",
    issuerTrustTier: "adi_accredited",
    taskDescription: "mobility assistance",
    legalContext: ["ADA", "ACAA"],
    storage: "off_chain",
    credentialSubject: {dogTagId: "dogtag:0xdef"},
  };
}

function validEuHealthCert(): Record<string, unknown> {
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2", DOGTAG_CONTEXT_URI],
    type: ["VerifiableCredential"],
    id: "urn:uuid:eu-1",
    issuer: "did:web:issuer.example",
    validFrom: "2024-03-01",
    credentialSchema: {id: "https://dogtag.io/schemas/eu-health-cert/v1", type: "JsonSchema"},
    credentialStatus: {id: "https://dogtag.io/status/1", type: "DogTagStatus2025"},
    attestationType: "generic",
    signatureTrustTier: "self_attested",
    legalEffect: "evidentiary",
    legalBasisVersion: "v1",
    jurisdiction: "EU",
    recordType: "EU_HEALTH_CERT",
    validUntilEntry: "2024-03-11",
    onwardValid: "2024-07-11",
    echinococcusRequired: true,
    treatmentBeforeEntry: 48,
    credentialSubject: {
      dogTagId: "dogtag:0xeu",
      microchip: {code: "985141006580319", standard: "ISO_11784_11785", implantDate: "2023-10-01"},
    },
  };
}

function validCdcImportForm(): Record<string, unknown> {
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2", DOGTAG_CONTEXT_URI],
    type: ["VerifiableCredential"],
    id: "urn:uuid:cdc-1",
    issuer: "did:web:issuer.example",
    validFrom: "2024-01-01",
    credentialSchema: {id: "https://dogtag.io/schemas/cdc-import-form/v1", type: "JsonSchema"},
    credentialStatus: {id: "https://dogtag.io/status/1", type: "DogTagStatus2025"},
    attestationType: "generic",
    signatureTrustTier: "self_attested",
    legalEffect: "evidentiary",
    legalBasisVersion: "v1",
    jurisdiction: "US",
    recordType: "CDC_IMPORT_FORM",
    ageMonthsAtEntry: 8,
    credentialSubject: {dogTagId: "dogtag:0xcdc"},
  };
}

describe("S2 registry - valid fixtures pass both validateSchema and their JSON Schema", () => {
  const cases: Array<[string, string, () => Record<string, unknown>]> = [
    ["DOG_PROFILE", "https://dogtag.io/schemas/dog-profile/v1", validDogProfile],
    ["RabiesVaccinationCertificate", "https://dogtag.io/schemas/rabies-vaccination/v1", validRabies],
    ["SERVICE_ATTESTATION", "https://dogtag.io/schemas/service-attestation/v1", validServiceAttestation],
    ["EU_HEALTH_CERT", "https://dogtag.io/schemas/eu-health-cert/v1", validEuHealthCert],
    ["CDC_IMPORT_FORM", "https://dogtag.io/schemas/cdc-import-form/v1", validCdcImportForm],
  ];

  for (const [name, schemaId, build] of cases) {
    it(`${name}: passes validateSchema and ${schemaId}`, () => {
      const fixture = build();
      expect(() => validateSchema(clone(fixture))).not.toThrow();
      const validate = schemaFor(schemaId);
      const ok = validate(fixture);
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
    });
  }
});

describe("S2 registry - every registered schema compiles under ajv strict mode", () => {
  it("all nine schema files (envelope + 5 record types + the WP4.10S redacted-tag-artifact custody/export format + the WP4.14S generic vaccination record + the WP4.14S record-artifact custody/export format) are registered and compile", () => {
    expect(schemaFiles.length).toBe(9);
    for (const s of registrySchemas) {
      expect(ajv.getSchema(s.$id), s.$id).toBeTypeOf("function");
    }
  });
});

interface ViolationCase {
  name: string;
  schemaId: string;
  build: () => Record<string, unknown>;
  mutate: (c: Record<string, unknown>) => void;
  needle: string;
  /** true: this schema's own JSON Schema keywords must reject the mutated fixture outright.
   *  false: the JSON Schema must STILL accept it (the rule is genuinely inexpressible in JSON
   *  Schema), and the violation must instead be named in that schema's x-validationRules. */
  expectAjvRejects: boolean;
}

const violationCases: ViolationCase[] = [
  // --- DOG_PROFILE (fully JSON-Schema-expressible: expectAjvRejects true throughout) ---
  {
    name: "dog-profile: bad sex enum",
    schemaId: "https://dogtag.io/schemas/dog-profile/v1",
    build: validDogProfile,
    mutate: (c) => {
      (c.credentialSubject as Record<string, unknown>).sex = "unknown";
    },
    needle: "sex must be one of",
    expectAjvRejects: true,
  },
  {
    name: "dog-profile: bad neuterStatus enum",
    schemaId: "https://dogtag.io/schemas/dog-profile/v1",
    build: validDogProfile,
    mutate: (c) => {
      (c.credentialSubject as Record<string, unknown>).neuterStatus = "unknown";
    },
    needle: "neuterStatus must be one of",
    expectAjvRejects: true,
  },
  {
    name: "dog-profile: ownerIdentity.name non-string",
    schemaId: "https://dogtag.io/schemas/dog-profile/v1",
    build: validDogProfile,
    mutate: (c) => {
      ((c.credentialSubject as Record<string, any>).ownerIdentity as Record<string, unknown>).name = 42;
    },
    needle: "ownerIdentity.name must be a string",
    expectAjvRejects: true,
  },
  {
    name: "dog-profile: weightHistory[0].value non-decimal",
    schemaId: "https://dogtag.io/schemas/dog-profile/v1",
    build: validDogProfile,
    mutate: (c) => {
      ((c.credentialSubject as Record<string, any>).weightHistory as Array<Record<string, unknown>>)[0]!.value =
        "heavy";
    },
    needle: "weightHistory[0].value must be a decimal string",
    expectAjvRejects: true,
  },
  {
    name: "dog-profile: optional microchip present with bad code still shape-checked",
    schemaId: "https://dogtag.io/schemas/dog-profile/v1",
    build: validDogProfile,
    mutate: (c) => {
      (c.credentialSubject as Record<string, unknown>).microchip = {
        code: "abc",
        standard: "ISO_11784_11785",
        implantDate: "2023-01-01",
      };
    },
    needle: "microchip.code must match",
    expectAjvRejects: true,
  },
  // --- RabiesVaccinationCertificate ---
  {
    name: "rabies: vaccineManufacturer missing",
    schemaId: "https://dogtag.io/schemas/rabies-vaccination/v1",
    build: validRabies,
    mutate: (c) => {
      delete c.vaccineManufacturer;
    },
    needle: "vaccineManufacturer is required",
    expectAjvRejects: true,
  },
  {
    name: "rabies: microchip.code 14 digits",
    schemaId: "https://dogtag.io/schemas/rabies-vaccination/v1",
    build: validRabies,
    mutate: (c) => {
      (c.credentialSubject as Record<string, any>).microchip.code = "98514100658031";
    },
    needle: "microchip.code must match",
    expectAjvRejects: true,
  },
  {
    name: "rabies: microchip.code non-string",
    schemaId: "https://dogtag.io/schemas/rabies-vaccination/v1",
    build: validRabies,
    mutate: (c) => {
      (c.credentialSubject as Record<string, any>).microchip.code = 985141006580319;
    },
    needle: "microchip.code must be a string",
    expectAjvRejects: true,
  },
  {
    name: "rabies: bad signatureTrustTier",
    schemaId: "https://dogtag.io/schemas/rabies-vaccination/v1",
    build: validRabies,
    mutate: (c) => {
      c.signatureTrustTier = "bogus";
    },
    needle: "signatureTrustTier must be one of",
    expectAjvRejects: true,
  },
  {
    name: "rabies: primary series validFrom off by one day (x-validationRules)",
    schemaId: "https://dogtag.io/schemas/rabies-vaccination/v1",
    build: validRabies,
    mutate: (c) => {
      c.validFrom = "2024-02-02"; // +22d instead of +21d
    },
    needle: "validFrom must == vaccinationDate + 21 days",
    expectAjvRejects: false,
  },
  {
    name: "rabies: titer.resultIUml below 0.5 (x-validationRules)",
    schemaId: "https://dogtag.io/schemas/rabies-vaccination/v1",
    build: validRabies,
    mutate: (c) => {
      (c.titer as Record<string, unknown>).resultIUml = "0.4";
    },
    needle: 'titer.resultIUml must be >= "0.5"',
    expectAjvRejects: false,
  },
  {
    name: "rabies: microchip.implantDate after vaccinationDate (x-validationRules)",
    schemaId: "https://dogtag.io/schemas/rabies-vaccination/v1",
    build: validRabies,
    mutate: (c) => {
      (c.credentialSubject as Record<string, any>).microchip.implantDate = "2024-06-01"; // after vaccinationDate
    },
    needle: "microchip.implantDate must be <= vaccinationDate",
    expectAjvRejects: false,
  },
  {
    name: "rabies: animal under 12 weeks at vaccination (x-validationRules)",
    schemaId: "https://dogtag.io/schemas/rabies-vaccination/v1",
    build: validRabies,
    mutate: (c) => {
      (c.credentialSubject as Record<string, unknown>).dateOfBirth = "2024-01-01"; // 10 days before vaccinationDate
    },
    needle: "animal age at vaccination must be >= 12 weeks",
    expectAjvRejects: false,
  },
  {
    name: "rabies: titer.sampledAt too soon after vaccinationDate (x-validationRules)",
    schemaId: "https://dogtag.io/schemas/rabies-vaccination/v1",
    build: validRabies,
    mutate: (c) => {
      (c.titer as Record<string, unknown>).sampledAt = "2024-01-15"; // only 4 days after vaccinationDate
    },
    needle: "titer.sampledAt must be >= vaccinationDate + 30 days",
    expectAjvRejects: false,
  },
  {
    name: "rabies: titer at the alternate credentialSubject.titer location with non-decimal resultIUml",
    schemaId: "https://dogtag.io/schemas/rabies-vaccination/v1",
    build: validRabies,
    mutate: (c) => {
      // schema.ts accepts titer at EITHER location (root titer takes precedence when both are
      // present); moving it to credentialSubject.titer alone still exercises the same shape check.
      const titer = c.titer;
      delete c.titer;
      (c.credentialSubject as Record<string, unknown>).titer = {...(titer as Record<string, unknown>), resultIUml: "heavy"};
    },
    needle: "titer.resultIUml must be a decimal string",
    expectAjvRejects: true,
  },
  // --- SERVICE_ATTESTATION ---
  {
    name: "service-attestation: storage not off_chain",
    schemaId: "https://dogtag.io/schemas/service-attestation/v1",
    build: validServiceAttestation,
    mutate: (c) => {
      c.storage = "on_chain";
    },
    needle: 'storage must == "off_chain"',
    expectAjvRejects: true,
  },
  {
    name: "service-attestation: bad assistanceType",
    schemaId: "https://dogtag.io/schemas/service-attestation/v1",
    build: validServiceAttestation,
    mutate: (c) => {
      c.assistanceType = "bogus";
    },
    needle: "assistanceType must be one of",
    expectAjvRejects: true,
  },
  // --- EU_HEALTH_CERT ---
  {
    name: "eu-health-cert: validUntilEntry off by one day (x-validationRules)",
    schemaId: "https://dogtag.io/schemas/eu-health-cert/v1",
    build: validEuHealthCert,
    mutate: (c) => {
      c.validUntilEntry = "2024-03-12"; // +11d instead of +10d
    },
    needle: "validUntilEntry must == validFrom + 10 days",
    expectAjvRejects: false,
  },
  {
    name: "eu-health-cert: onwardValid beyond entry+4mo (x-validationRules)",
    schemaId: "https://dogtag.io/schemas/eu-health-cert/v1",
    build: validEuHealthCert,
    mutate: (c) => {
      c.onwardValid = "2024-07-12"; // one day past entry + 4 months
    },
    needle: "onwardValid must be <= entry + 4 months",
    expectAjvRejects: false,
  },
  {
    name: "eu-health-cert: echinococcus treatment outside range",
    schemaId: "https://dogtag.io/schemas/eu-health-cert/v1",
    build: validEuHealthCert,
    mutate: (c) => {
      c.treatmentBeforeEntry = 12;
    },
    needle: "echinococcus treatmentBeforeEntry must be within",
    expectAjvRejects: true,
  },
  {
    name: "eu-health-cert: microchip missing entirely",
    schemaId: "https://dogtag.io/schemas/eu-health-cert/v1",
    build: validEuHealthCert,
    mutate: (c) => {
      delete (c.credentialSubject as Record<string, unknown>).microchip;
    },
    needle: "credentialSubject.microchip must be an object",
    expectAjvRejects: true,
  },
  // --- CDC_IMPORT_FORM ---
  {
    name: "cdc-import-form: ageMonthsAtEntry below 6",
    schemaId: "https://dogtag.io/schemas/cdc-import-form/v1",
    build: validCdcImportForm,
    mutate: (c) => {
      c.ageMonthsAtEntry = 5;
    },
    needle: "ageMonthsAtEntry must be >= 6",
    expectAjvRejects: true,
  },
  {
    name: "cdc-import-form: ageMonthsAtEntry non-numeric",
    schemaId: "https://dogtag.io/schemas/cdc-import-form/v1",
    build: validCdcImportForm,
    mutate: (c) => {
      c.ageMonthsAtEntry = "8";
    },
    needle: "ageMonthsAtEntry must be >= 6",
    expectAjvRejects: true,
  },
  {
    name: "cdc-import-form: cdcPath standard requires microchip (if/then)",
    schemaId: "https://dogtag.io/schemas/cdc-import-form/v1",
    build: validCdcImportForm,
    mutate: (c) => {
      c.cdcPath = "standard";
    },
    needle: "credentialSubject.microchip must be an object",
    expectAjvRejects: true,
  },
];

describe("S2 registry - enumerated violation coverage is total (JSON Schema or x-validationRules, never neither)", () => {
  it("pins the enumerated case count (guards a case silently dropped from this list)", () => {
    expect(violationCases.length).toBe(24);
  });

  it("pins the structural-vs-delegated split (17 structural, 7 delegated - matches the 7 x-validationRules entries across the whole registry)", () => {
    const structural = violationCases.filter((vc) => vc.expectAjvRejects).length;
    const delegated = violationCases.filter((vc) => !vc.expectAjvRejects).length;
    expect(structural).toBe(17);
    expect(delegated).toBe(7);
    const totalRules = registrySchemas.reduce((n, s) => n + (s["x-validationRules"]?.length ?? 0), 0);
    expect(totalRules).toBe(7);
  });

  for (const vc of violationCases) {
    it(vc.name, () => {
      const fixture = vc.build();
      vc.mutate(fixture);
      expectViolation(clone(fixture), vc.needle);
      assertCoverage(vc.schemaId, fixture, vc.needle, vc.expectAjvRejects);
    });
  }
});

interface PositiveCase {
  name: string;
  schemaId: string;
  build: () => Record<string, unknown>;
  /** Mutates a VALID fixture into another shape validateSchema still accepts (never a violation) -
   *  the registry must accept it too, or the registry is stricter than the code it claims to mirror. */
  mutate: (c: Record<string, unknown>) => void;
}

const positiveCases: PositiveCase[] = [
  {
    name: "rabies: accepted without credentialSubject.dateOfBirth (schema.ts requires it only for DOG_PROFILE, not for RabiesVaccinationCertificate)",
    schemaId: "https://dogtag.io/schemas/rabies-vaccination/v1",
    build: validRabies,
    mutate: (c) => {
      delete (c.credentialSubject as Record<string, unknown>).dateOfBirth;
    },
  },
  {
    name: "rabies: accepted without any titer object (titer is optional; the whole check is skipped when absent from both locations)",
    schemaId: "https://dogtag.io/schemas/rabies-vaccination/v1",
    build: validRabies,
    mutate: (c) => {
      delete c.titer;
    },
  },
  {
    name: "dog-profile: accepted without weightHistory at all (schema.ts only validates it when the key is present)",
    schemaId: "https://dogtag.io/schemas/dog-profile/v1",
    build: validDogProfile,
    mutate: (c) => {
      delete (c.credentialSubject as Record<string, unknown>).weightHistory;
    },
  },
  {
    name: "dog-profile: accepted without microchip (needsChip is false for DOG_PROFILE unless cdcPath == \"standard\")",
    schemaId: "https://dogtag.io/schemas/dog-profile/v1",
    build: validDogProfile,
    mutate: (c) => {
      delete (c.credentialSubject as Record<string, unknown>).microchip;
    },
  },
  {
    name: "cdc-import-form: accepted without cdcPath (only cdcPath == \"standard\" triggers the cross-cutting microchip rule; absence never does)",
    schemaId: "https://dogtag.io/schemas/cdc-import-form/v1",
    build: validCdcImportForm,
    mutate: (c) => {
      delete c.cdcPath;
    },
  },
  {
    name: "rabies: accepted with a well-formed titer at the alternate credentialSubject.titer location",
    schemaId: "https://dogtag.io/schemas/rabies-vaccination/v1",
    build: validRabies,
    mutate: (c) => {
      const titer = c.titer;
      delete c.titer;
      (c.credentialSubject as Record<string, unknown>).titer = titer;
    },
  },
  {
    name: "dog-profile: accepted with non-string color/registrationId/registrationAuthority, including a literal null (schema.ts does not know these fields exist, so it validates nothing about them - not even that they are strings, not even that they are non-null; the registry must not be stricter, D1 fix)",
    schemaId: "https://dogtag.io/schemas/dog-profile/v1",
    build: validDogProfile,
    mutate: (c) => {
      (c.credentialSubject as Record<string, unknown>).color = 42;
      (c.credentialSubject as Record<string, unknown>).registrationId = null;
      (c.credentialSubject as Record<string, unknown>).registrationAuthority = ["not", "a", "string"];
    },
  },
];

describe("S2 registry - positive-direction conformance: everything validateSchema accepts, the registry must accept too (catches registry-stricter-than-code drift)", () => {
  it("pins the positive case count (guards a case silently dropped from this list)", () => {
    expect(positiveCases.length).toBe(7);
  });

  for (const pc of positiveCases) {
    it(pc.name, () => {
      const fixture = pc.build();
      pc.mutate(fixture);
      expect(() => validateSchema(clone(fixture))).not.toThrow();
      const validate = schemaFor(pc.schemaId);
      const ok = validate(fixture);
      expect(ok, `expected ${pc.schemaId} to accept a credential validateSchema accepts - errors: ${JSON.stringify(validate.errors)}`).toBe(true);
    });
  }
});

// ---- leaf-dictionary agreement: dictionary-driven plain-JSON -> typed-scalar conversion ----

interface LeafDictionary {
  entries: Record<string, {tags: string[]; requirement: string; notes?: string}>;
}

const dictionary: LeafDictionary = JSON.parse(
  readFileSync(resolve(SCHEMAS_DIR, "leaf-dictionary.v1.json"), "utf8"),
);

const TAG_BY_NAME: Record<string, TypeTag> = {
  Null: TypeTag.Null,
  Bool: TypeTag.Bool,
  String: TypeTag.String,
  Integer: TypeTag.Integer,
  Decimal: TypeTag.Decimal,
  Bytes: TypeTag.Bytes,
};

/** credentialSubject.weightHistory[3].value -> credentialSubject.weightHistory[*].value */
function normalizeKeyPath(path: string): string {
  return path.replace(/\[[0-9]+\]/g, "[*]");
}

/**
 * Convert a plain, schema.ts-valid credential into the typed-scalar tree flatten()/hashLeaf()
 * expect, using ONLY specs/schemas/leaf-dictionary.v1.json to decide each leaf's TypeTag. Throws
 * loudly if a leaf's keyPath is not in the dictionary - the failure mode this test exists to catch.
 * Empty objects/arrays are passed through UNCHANGED: flatten() already implements the F2a
 * empty-container-collapses-to-Null rule itself, so this converter must not duplicate it.
 */
function typifyWithDictionary(node: unknown, path: string): unknown {
  if (node === null) {
    return {tag: TypeTag.Null, value: null} satisfies TypedScalar;
  }
  if (Array.isArray(node)) {
    if (node.length === 0) return node; // let flatten's own empty-array rule handle it
    return node.map((el, i) => typifyWithDictionary(el, `${path}[${i}]`));
  }
  if (typeof node === "object") {
    const keys = Object.keys(node as Record<string, unknown>);
    if (keys.length === 0) return node; // let flatten's own empty-object rule handle it
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const childPath = path === "" ? k : `${path}.${k}`;
      out[k] = typifyWithDictionary((node as Record<string, unknown>)[k], childPath);
    }
    return out;
  }
  // primitive leaf
  const normalized = normalizeKeyPath(path);
  const entry = dictionary.entries[normalized];
  if (!entry) {
    throw new Error(`leaf-dictionary.v1.json has no entry for keyPath ${JSON.stringify(normalized)} (raw: ${path})`);
  }
  const tagName = entry.tags[0]!;
  const tag = TAG_BY_NAME[tagName];
  if (tag === undefined) throw new Error(`unknown tag name ${tagName} in dictionary entry ${normalized}`);
  let value: TypedScalar["value"];
  if (tag === TypeTag.Bool) {
    value = Boolean(node);
  } else {
    // String / Integer / Decimal all carry a canonical STRING value; a native JS number (e.g.
    // ageMonthsAtEntry, treatmentBeforeEntry) must be stringified, never hashed as a native number.
    value = String(node);
  }
  return {tag, value} as TypedScalar;
}

describe("S2 registry - leaf-dictionary.v1.json is sufficient to type every field of every valid fixture", () => {
  const fixtures: Array<[string, () => Record<string, unknown>]> = [
    ["DOG_PROFILE", validDogProfile],
    ["RabiesVaccinationCertificate", validRabies],
    ["SERVICE_ATTESTATION", validServiceAttestation],
    ["EU_HEALTH_CERT", validEuHealthCert],
    ["CDC_IMPORT_FORM", validCdcImportForm],
  ];

  for (const [name, build] of fixtures) {
    it(`${name}: every flattened keyPath is in the dictionary with an allowed tag`, () => {
      const fixture = build();
      const typed = typifyWithDictionary(fixture, "");
      const flat = flatten(typed);
      expect(flat.length).toBeGreaterThan(0);
      for (const {keyPath, scalar} of flat) {
        const normalized = normalizeKeyPath(keyPath);
        const entry = dictionary.entries[normalized];
        expect(entry, `keyPath ${JSON.stringify(keyPath)} (normalized ${JSON.stringify(normalized)}) missing from leaf-dictionary.v1.json`).toBeDefined();
        const tagName = TypeTag[scalar.tag];
        expect(
          entry!.tags.includes(tagName),
          `keyPath ${JSON.stringify(keyPath)} produced tag ${tagName}, not among dictionary's allowed tags ${JSON.stringify(entry!.tags)}`,
        ).toBe(true);
      }
    });
  }

  // The dictionary's ONE "nullable" entry (credentialSubject.weightHistory) is otherwise never
  // exercised above: every fixture's weightHistory is non-empty, so flatten() never takes F2a's
  // empty-array-collapses-to-Null branch for it, and the "every flattened keyPath is in the
  // dictionary" loop above degenerates to checking that typifyWithDictionary's own lookups agree
  // with themselves (it already threw during typification if a keyPath were missing, so flatten
  // - which derives keyPaths from the exact structure typify walked - cannot produce a keyPath
  // typify did not already resolve). This case is the one place flatten() can produce a keyPath
  // typifyWithDictionary never looked anything up for, because it emerges from flatten's OWN
  // empty-container rule, not from a typed leaf typify built - so it is the one assertion in this
  // describe block with independent power, and the one that actually proves the dictionary's
  // "nullable" category is correct rather than merely asserted in prose.
  it("DOG_PROFILE with an empty weightHistory: flatten collapses it to one Null leaf, matching the dictionary's nullable entry", () => {
    const fixture = validDogProfile();
    (fixture.credentialSubject as Record<string, unknown>).weightHistory = [];

    expect(() => validateSchema(clone(fixture))).not.toThrow();
    const validate = schemaFor("https://dogtag.io/schemas/dog-profile/v1");
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);

    const typed = typifyWithDictionary(fixture, "");
    const flat = flatten(typed);
    const wh = flat.filter((f) => f.keyPath === "credentialSubject.weightHistory");
    expect(wh.length).toBe(1);
    expect(wh[0]!.scalar.tag).toBe(TypeTag.Null);
    expect(flat.some((f) => f.keyPath.startsWith("credentialSubject.weightHistory["))).toBe(false);

    const entry = dictionary.entries["credentialSubject.weightHistory"];
    expect(entry, "leaf-dictionary.v1.json must have an entry for the bare weightHistory path").toBeDefined();
    expect(entry!.requirement).toBe("nullable");
    expect(entry!.tags.includes("Null")).toBe(true);
  });

  // D4's alternate titer location: a credential using credentialSubject.titer instead of root-level
  // titer flattens to credentialSubject.titer.* keyPaths that no fixture above ever produces (every
  // fixture uses root-level titer). Without the credentialSubject.titer.* entries added to
  // leaf-dictionary.v1.json alongside the schema's new $defs/titer reference, typifyWithDictionary
  // would throw on this exact fixture - making this test the thing that actually EXERCISES those
  // entries, rather than merely asserting them correct in prose.
  it("RabiesVaccinationCertificate with titer at the alternate credentialSubject.titer location: every flattened credentialSubject.titer.* keyPath is in the dictionary with an allowed tag", () => {
    const fixture = validRabies();
    const titer = fixture.titer;
    delete fixture.titer;
    (fixture.credentialSubject as Record<string, unknown>).titer = titer;

    expect(() => validateSchema(clone(fixture))).not.toThrow();
    const validate = schemaFor("https://dogtag.io/schemas/rabies-vaccination/v1");
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);

    const typed = typifyWithDictionary(fixture, "");
    const flat = flatten(typed);
    expect(flat.some((f) => f.keyPath.startsWith("titer."))).toBe(false);
    const titerLeaves = flat.filter((f) => f.keyPath.startsWith("credentialSubject.titer."));
    expect(titerLeaves.length).toBe(3); // resultIUml, sampledAt, labId

    for (const {keyPath, scalar} of titerLeaves) {
      const entry = dictionary.entries[keyPath];
      expect(entry, `keyPath ${JSON.stringify(keyPath)} missing from leaf-dictionary.v1.json`).toBeDefined();
      const tagName = TypeTag[scalar.tag];
      expect(
        entry!.tags.includes(tagName),
        `keyPath ${JSON.stringify(keyPath)} produced tag ${tagName}, not among dictionary's allowed tags ${JSON.stringify(entry!.tags)}`,
      ).toBe(true);
    }
  });

  // WP4.12S added three optional String leaves (color, registrationId, registrationAuthority) as
  // matching schema-property + dictionary-entry pairs, the same shape as the titer test above. D1's
  // fix (dropping the type keyword from the three schema properties, so the registry cannot become
  // stricter than schema.ts, which does not know these fields exist) only touches validateSchema-vs-
  // ajv agreement; it never exercises the dictionary, typifyWithDictionary, or flatten. Without a
  // test here, nothing anywhere asserted that a profile actually carrying these three fields
  // flattens to three String leaves at the flat keyPaths - the entire point of the work item - so a
  // later edit that deleted a dictionary entry, changed its tags to ["Bytes"], or renamed a keyPath
  // would have kept every other test in this file green. Two cases, not one: "optional means no
  // leaf, not a Null leaf" is the half a present-only test cannot show.
  const NEW_OPTIONAL_LEAVES: Record<string, string> = {
    "credentialSubject.color": "brown",
    "credentialSubject.registrationId": "AVS-12345",
    "credentialSubject.registrationAuthority": "AVS Singapore",
  };

  it("DOG_PROFILE with color/registrationId/registrationAuthority set: each is in the dictionary as optional String and flattens to exactly one String leaf at its flat keyPath", () => {
    const fixture = validDogProfile();
    Object.assign(fixture.credentialSubject as Record<string, unknown>, {
      color: "brown",
      registrationId: "AVS-12345",
      registrationAuthority: "AVS Singapore",
    });

    expect(() => validateSchema(clone(fixture))).not.toThrow();
    const validate = schemaFor("https://dogtag.io/schemas/dog-profile/v1");
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);

    const flat = flatten(typifyWithDictionary(fixture, ""));
    for (const [keyPath, value] of Object.entries(NEW_OPTIONAL_LEAVES)) {
      const entry = dictionary.entries[keyPath];
      expect(entry, `leaf-dictionary.v1.json must have an entry for ${keyPath}`).toBeDefined();
      expect(entry!.tags, keyPath).toEqual(["String"]);
      expect(entry!.requirement, keyPath).toBe("optional");

      const hits = flat.filter((f) => f.keyPath === keyPath);
      expect(hits.length, keyPath).toBe(1);
      expect(hits[0]!.scalar.tag, keyPath).toBe(TypeTag.String);
      expect(hits[0]!.scalar.value, keyPath).toBe(value);
    }
  });

  it("DOG_PROFILE without color/registrationId/registrationAuthority: no leaf at all at those keyPaths (optional means absent, never a Null leaf)", () => {
    const fixture = validDogProfile();
    const flat = flatten(typifyWithDictionary(fixture, ""));
    for (const keyPath of Object.keys(NEW_OPTIONAL_LEAVES)) {
      expect(flat.some((f) => f.keyPath === keyPath), keyPath).toBe(false);
    }
  });
});
