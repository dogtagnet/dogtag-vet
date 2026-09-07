// S2 registry conformance for specs/schemas/dogtag.vaccination.v1.schema.json (WP4.14S, advisor round
// 2 item 2) - proves the schema's OWN stated constraints (recordType const, the self-referential
// credentialSchema.id const, and the three nested required lists) actually fire against a document,
// not merely that the file compiles under ajv strict (schema_registry.test.ts's
// `getSchema($id)`/`addSchema` loop already proves that much for every registry file, this one
// included).
//
// Deliberately NOT added to schema_registry.test.ts's fixture/violation lists: this record type has NO
// schema.ts/validateSchema branch at all (the schema file's own top-level "description" says so - a
// VACCINATION credential is carried as a RecordArtifact, never run through wrap.ts/schema.ts's
// validateSchema pipeline), so there is no code side for that file's `assertCoverage` /
// `expectViolation` helpers to pin against. This file is ajv-only, exactly the same footing
// record_artifact_schema.test.ts already stands on for the sibling wire-shape schema.
//
// Advisor round 2 (second pass): schema_registry.test.ts's own third assertion - flattening every
// valid fixture proves specs/schemas/leaf-dictionary.v1.json is SUFFICIENT to type every field, not
// merely that a hand-picked sample of it is correct - deliberately excludes this record type for the
// same no-schema.ts-branch reason above, so the 6 new FHIR entries, credentialSchema.version, and the
// 6 issuer.* entries this wave added to the dictionary (S2) had no fixture proving they cover an
// actual vaccination credential. Reproduced below against validVaccination() directly.
import {describe, it, expect} from "vitest";
import {readFileSync, readdirSync} from "node:fs";
import {resolve} from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {DOGTAG_CONTEXT_URI} from "../src/schema.js";
import {flatten} from "../src/flatten.js";
import {TypeTag, type TypedScalar} from "../src/types.js";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCHEMAS_DIR = resolve(REPO_ROOT, "specs", "schemas");
const SCHEMA_ID = "https://dogtag.io/schemas/vaccination/v1";

// The vaccination schema `$ref`s the shared envelope, so (like schema_registry.test.ts) the whole
// registry directory is loaded into one ajv instance for $ref resolution - a lone `ajv.compile(schema)`
// on just this file would leave `https://dogtag.io/schemas/envelope/v1` unresolved.
const schemaFiles = readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith(".schema.json"));
const registrySchemas = schemaFiles.map((f) => JSON.parse(readFileSync(resolve(SCHEMAS_DIR, f), "utf8")));
const ajv = new Ajv2020({strict: true, strictTuples: false, allErrors: true});
ajv.addKeyword({keyword: "version"});
ajv.addKeyword({keyword: "x-validationRules"});
for (const s of registrySchemas) ajv.addSchema(s);
const validate = ajv.getSchema(SCHEMA_ID);
if (!validate) throw new Error(`schema not registered: ${SCHEMA_ID}`);

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

/** A realistic, fully-populated vaccination credential: every envelope-required field, every field
 * this schema itself requires (recordType; credentialSchema.id/version; issuer.chainId/contract/
 * operator), plus a representative sample of the description-only FHIR/clinical fields. */
function validVaccination(): Record<string, unknown> {
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2", DOGTAG_CONTEXT_URI],
    type: ["VerifiableCredential", "VaccinationCertificate"],
    id: "urn:uuid:vaccination-1",
    issuer: {
      chainId: 135,
      contract: "0x86d9ac6c094783e6a27d3bdbb6ef868060256c75",
      operator: "0x15759c525000000000000000000000000000cda",
      name: "Example Veterinary Clinic",
      domain: "vet.example",
      address: "123 Example St",
    },
    validFrom: "2024-01-11",
    validUntil: "2027-01-11",
    nextDueDate: "2027-01-11",
    credentialSchema: {id: SCHEMA_ID, version: "1.0.0"},
    credentialStatus: {id: "https://dogtag.io/status/1", type: "DogTagStatus2025"},
    attestationType: "vaccination",
    signatureTrustTier: "licensed_vet",
    legalEffect: "evidentiary",
    legalBasisVersion: "EU-2013-576-v1",
    jurisdiction: "EU",
    recordType: "VACCINATION",
    targetDisease: "distemper",
    targetDiseaseCode: "VeNom-12345",
    vaccineProductName: "Nobivac DHPPi",
    vaccineProductCode: "USDA-PCN-54321",
    vaccineManufacturer: "MSD Animal Health",
    batchLotNumber: "LOT-2024-07",
    vaccinationDate: "2024-01-11",
    series: "booster",
    authorizedVet: "did:web:vet.example#vet1",
    route: "subcutaneous",
    site: "left shoulder",
    doseQuantity: "1",
    vaccineExpirationDate: "2025-06-01",
    credentialSubject: {dogTagId: "dogtag:0xabc"},
  };
}

describe("dogtag.vaccination.v1.schema.json - shape validation", () => {
  it("compiles under ajv strict (draft 2020-12) and resolves its envelope $ref", () => {
    expect(typeof validate).toBe("function");
  });

  it("accepts a realistic, fully-populated vaccination credential", () => {
    const ok = validate!(validVaccination());
    expect(ok, JSON.stringify(validate!.errors)).toBe(true);
  });

  it("accepts the same credential with every description-only clinical field DROPPED - only the seven code-enforced fields plus the envelope are actually required", () => {
    const minimal = validVaccination();
    for (const field of [
      "targetDisease",
      "targetDiseaseCode",
      "vaccineProductName",
      "vaccineProductCode",
      "vaccineManufacturer",
      "batchLotNumber",
      "vaccinationDate",
      "validUntil",
      "nextDueDate",
      "series",
      "authorizedVet",
      "route",
      "site",
      "doseQuantity",
      "vaccineExpirationDate",
    ]) {
      delete minimal[field];
    }
    expect(validate!(minimal), JSON.stringify(validate!.errors)).toBe(true);
  });

  it("accepts a description-only field of an unexpected TYPE - proves these fields are genuinely unconstrained, not merely undocumented as constrained", () => {
    const mutated = validVaccination();
    mutated.targetDisease = 42; // description-only: no `type` keyword to violate
    mutated.doseQuantity = {amount: 1}; // ditto
    expect(validate!(mutated), JSON.stringify(validate!.errors)).toBe(true);
  });

  interface NegativeCase {
    name: string;
    mutate: (c: Record<string, unknown>) => void;
  }

  const negativeCases: NegativeCase[] = [
    {
      name: "recordType is a different record type (const mismatch)",
      mutate: (c) => {
        c.recordType = "TRAVEL_CLEARANCE";
      },
    },
    {
      name: "recordType is missing entirely (this schema's own `required`)",
      mutate: (c) => {
        delete c.recordType;
      },
    },
    {
      name: "credentialSchema.id names a different schema (const mismatch - the self-reference is not free-form)",
      mutate: (c) => {
        (c.credentialSchema as Record<string, unknown>).id = "https://dogtag.io/schemas/rabies-vaccination/v1";
      },
    },
    {
      name: "credentialSchema.version is missing (nested `required`)",
      mutate: (c) => {
        delete (c.credentialSchema as Record<string, unknown>).version;
      },
    },
    {
      name: "issuer.contract is missing (nested `required`)",
      mutate: (c) => {
        delete (c.issuer as Record<string, unknown>).contract;
      },
    },
    {
      name: "issuer.chainId is null (fails the `not: {type: null}` guard)",
      mutate: (c) => {
        (c.issuer as Record<string, unknown>).chainId = null;
      },
    },
    {
      name: "issuer is a bare DID string (rabies' shape) instead of the chain-anchor object this record type requires",
      mutate: (c) => {
        c.issuer = "did:web:vet.example";
      },
    },
    {
      name: "jurisdiction is missing - proves the allOf envelope composition is actually wired in, not merely declared",
      mutate: (c) => {
        delete c.jurisdiction;
      },
    },
  ];

  it("pins the enumerated negative-case count (guards a case silently dropped)", () => {
    expect(negativeCases.length).toBe(8);
  });

  describe("negative: a credential violating one of this schema's own stated constraints is rejected", () => {
    for (const nc of negativeCases) {
      it(nc.name, () => {
        const broken = clone(validVaccination());
        nc.mutate(broken);
        expect(validate!(broken), `expected the schema to reject: ${nc.name}`).toBe(false);
      });
    }
  });
});

// ---- leaf-dictionary agreement (advisor round 2 second pass) - deliberate 4th independent
// transcription of schema_registry.test.ts's own typifyWithDictionary/normalizeKeyPath, not a shared
// import: this repository's established convention for this class of code (see recordArtifact.ts's
// file header for the fullest statement of the rationale) - each test file's own tests fully pin its
// own behavior, and a future drift between the transcriptions is exactly what would surface as a
// spurious failure in one file but not the other. ----

interface LeafDictionary {
  entries: Record<string, {tags: string[]; requirement: string; notes?: string}>;
}

const dictionary: LeafDictionary = JSON.parse(readFileSync(resolve(SCHEMAS_DIR, "leaf-dictionary.v1.json"), "utf8"));

const TAG_BY_NAME: Record<string, TypeTag> = {
  Null: TypeTag.Null,
  Bool: TypeTag.Bool,
  String: TypeTag.String,
  Integer: TypeTag.Integer,
  Decimal: TypeTag.Decimal,
  Bytes: TypeTag.Bytes,
};

function normalizeKeyPath(path: string): string {
  return path.replace(/\[[0-9]+\]/g, "[*]");
}

/** Convert a plain, schema-valid vaccination credential into the typed-scalar tree flatten()/
 * hashLeaf() expect, using ONLY leaf-dictionary.v1.json to decide each leaf's TypeTag - throws loudly
 * if a leaf's keyPath is not in the dictionary, the failure mode this test exists to catch. */
function typifyWithDictionary(node: unknown, path: string): unknown {
  if (node === null) return {tag: TypeTag.Null, value: null} satisfies TypedScalar;
  if (Array.isArray(node)) {
    if (node.length === 0) return node;
    return node.map((el, i) => typifyWithDictionary(el, `${path}[${i}]`));
  }
  if (typeof node === "object") {
    const keys = Object.keys(node as Record<string, unknown>);
    if (keys.length === 0) return node;
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const childPath = path === "" ? k : `${path}.${k}`;
      out[k] = typifyWithDictionary((node as Record<string, unknown>)[k], childPath);
    }
    return out;
  }
  const normalized = normalizeKeyPath(path);
  const entry = dictionary.entries[normalized];
  if (!entry) {
    throw new Error(`leaf-dictionary.v1.json has no entry for keyPath ${JSON.stringify(normalized)} (raw: ${path})`);
  }
  const tagName = entry.tags[0]!;
  const tag = TAG_BY_NAME[tagName];
  if (tag === undefined) throw new Error(`unknown tag name ${tagName} in dictionary entry ${normalized}`);
  const value: TypedScalar["value"] = tag === TypeTag.Bool ? Boolean(node) : String(node);
  return {tag, value} as TypedScalar;
}

describe("S2 registry - leaf-dictionary.v1.json is sufficient to type every field of a real vaccination credential", () => {
  it("every flattened keyPath of validVaccination() is in the dictionary with an allowed tag", () => {
    const typed = typifyWithDictionary(validVaccination(), "");
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

  // Pins that this fixture actually exercises every S2-added dictionary entry, not merely SOME of the
  // fields covered by them - a fixture that dropped one of these silently would still pass the loop
  // above (it only checks what IS present), so the coverage claim needs this separate, explicit list.
  it("validVaccination() exercises every keyPath this wave (S2) added to the dictionary", () => {
    const typed = typifyWithDictionary(validVaccination(), "");
    const flat = flatten(typed);
    const present = new Set(flat.map(({keyPath}) => normalizeKeyPath(keyPath)));
    const s2Additions = [
      "credentialSchema.version",
      "issuer.chainId",
      "issuer.contract",
      "issuer.operator",
      "issuer.name",
      "issuer.domain",
      "issuer.address",
      "targetDisease",
      "targetDiseaseCode",
      "route",
      "site",
      "doseQuantity",
      "vaccineExpirationDate",
    ];
    for (const keyPath of s2Additions) {
      expect(present.has(keyPath), `expected validVaccination() to exercise ${JSON.stringify(keyPath)}`).toBe(true);
    }
  });
});
