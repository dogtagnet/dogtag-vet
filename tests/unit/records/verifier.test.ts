import {describe, expect, it} from "vitest";
import {recordTypeKey} from "@dogtag/standard";
import {buildVaccinationRecord} from "@/lib/records/build";
import {verifyPresentedRecordArtifact, type RecordChainDeps} from "@/lib/records/verifier";

const CHAIN_ID = 1337;
const CLONE = "0x0000000000000000000000000000000000c10be5";
const OPERATOR = "0x0000000000000000000000000000000000000ff1";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function buildArtifact(overrides: {validUntil?: string; chainId?: number} = {}) {
  const {leaves, root} = buildVaccinationRecord(
    {
      targetDisease: "rabies",
      vaccineProductName: "Rabvac 3",
      vaccineManufacturer: "Boehringer Ingelheim",
      batchLotNumber: "LOT-998",
      vaccinationDate: "2026-09-01",
      validFrom: "2026-09-01",
      validUntil: overrides.validUntil ?? "2027-09-01",
    },
    {dogTagIdField: "424242", issuer: {chainId: overrides.chainId ?? CHAIN_ID, contract: CLONE, operator: OPERATOR}},
  );
  return {
    protocolVersion: "dogtag-v2/1",
    artifactType: "record" as const,
    root,
    disclosed: leaves,
    obfuscatedLeafHashes: [] as string[],
    reservedLeafHashes: [] as string[],
  };
}

function agreeingDeps(): RecordChainDeps {
  return {
    readRootIssuer: async () => CLONE,
    readRecordTypeOf: async () => recordTypeKey("VACCINATION"),
    readIsValidRoot: async () => true,
    readIssuedBy: async () => OPERATOR,
  };
}

describe("verifyPresentedRecordArtifact", () => {
  it("crypto_failed: a tampered root never reaches the chain checks at all", async () => {
    const artifact = buildArtifact();
    const tampered = {...artifact, root: `0x${"f".repeat(64)}`};
    const result = await verifyPresentedRecordArtifact(tampered, agreeingDeps(), CHAIN_ID);
    expect(result).toEqual({stage: "crypto_failed"});
  });

  it("wrong_chain: the disclosed issuer.chainId leaf does not match the verifier's own chain - no chain read at all", async () => {
    const artifact = buildArtifact({chainId: 999});
    let called = false;
    const deps: RecordChainDeps = {
      ...agreeingDeps(),
      readRootIssuer: async () => {
        called = true;
        return CLONE;
      },
    };
    const result = await verifyPresentedRecordArtifact(artifact, deps, CHAIN_ID);
    expect(result).toEqual({stage: "wrong_chain"});
    expect(called).toBe(false);
  });

  it("chain_unreadable: readRootIssuer throws", async () => {
    const artifact = buildArtifact();
    const deps: RecordChainDeps = {...agreeingDeps(), readRootIssuer: async () => Promise.reject(new Error("RPC timeout"))};
    const result = await verifyPresentedRecordArtifact(artifact, deps, CHAIN_ID);
    expect(result).toEqual({stage: "chain_unreadable"});
  });

  it("not_anchored/root_unset: rootIssuer resolves to the zero address (never issued)", async () => {
    const artifact = buildArtifact();
    const deps: RecordChainDeps = {...agreeingDeps(), readRootIssuer: async () => ZERO_ADDRESS};
    const result = await verifyPresentedRecordArtifact(artifact, deps, CHAIN_ID);
    expect(result).toEqual({stage: "not_anchored", reason: "root_unset"});
  });

  it("not_anchored/issuer_mismatch: rootIssuer resolves to a DIFFERENT clone than the artifact claims", async () => {
    const artifact = buildArtifact();
    const deps: RecordChainDeps = {...agreeingDeps(), readRootIssuer: async () => "0x00000000000000000000000000000000000ff1ce"};
    const result = await verifyPresentedRecordArtifact(artifact, deps, CHAIN_ID);
    expect(result).toEqual({stage: "not_anchored", reason: "issuer_mismatch"});
  });

  it("chain_unreadable: the parallel recordTypeOf/isValid/issuedBy read throws after rootIssuer resolves", async () => {
    const artifact = buildArtifact();
    const deps: RecordChainDeps = {...agreeingDeps(), readIsValidRoot: async () => Promise.reject(new Error("RPC timeout"))};
    const result = await verifyPresentedRecordArtifact(artifact, deps, CHAIN_ID);
    expect(result).toEqual({stage: "chain_unreadable"});
  });

  it("not_anchored/record_type_mismatch: the resolved clone disagrees with the artifact's own claimed recordType", async () => {
    const artifact = buildArtifact();
    const deps: RecordChainDeps = {...agreeingDeps(), readRecordTypeOf: async () => `0x${"9".repeat(64)}`};
    const result = await verifyPresentedRecordArtifact(artifact, deps, CHAIN_ID);
    expect(result).toEqual({stage: "not_anchored", reason: "record_type_mismatch"});
  });

  it("not_anchored/operator_mismatch: issuedBy disagrees with the artifact's own claimed issuer.operator", async () => {
    const artifact = buildArtifact();
    const deps: RecordChainDeps = {...agreeingDeps(), readIssuedBy: async () => "0x0000000000000000000000000000000000000bad"};
    const result = await verifyPresentedRecordArtifact(artifact, deps, CHAIN_ID);
    expect(result).toEqual({stage: "not_anchored", reason: "operator_mismatch"});
  });

  it("verified/revoked: isValid is false once every other check agrees", async () => {
    const artifact = buildArtifact();
    const deps: RecordChainDeps = {...agreeingDeps(), readIsValidRoot: async () => false};
    const result = await verifyPresentedRecordArtifact(artifact, deps, CHAIN_ID);
    expect(result).toEqual({stage: "verified", issuerClone: CLONE, recordType: "VACCINATION", validity: "revoked"});
  });

  it("verified/valid: every check agrees, isValid true, validUntil in the future", async () => {
    const artifact = buildArtifact({validUntil: "2099-01-01"});
    const result = await verifyPresentedRecordArtifact(artifact, agreeingDeps(), CHAIN_ID);
    expect(result).toEqual({stage: "verified", issuerClone: CLONE, recordType: "VACCINATION", validity: "valid"});
  });

  it("verified/expired: every check agrees, isValid true, validUntil in the past", async () => {
    const artifact = buildArtifact({validUntil: "2000-01-01"});
    const result = await verifyPresentedRecordArtifact(artifact, agreeingDeps(), CHAIN_ID);
    expect(result).toEqual({stage: "verified", issuerClone: CLONE, recordType: "VACCINATION", validity: "expired"});
  });

  it("case-insensitive address comparisons: an all-uppercase rootIssuer response still agrees with a lowercase claim", async () => {
    const artifact = buildArtifact();
    const deps: RecordChainDeps = {...agreeingDeps(), readRootIssuer: async () => CLONE.toUpperCase().replace("0X", "0x")};
    const result = await verifyPresentedRecordArtifact(artifact, deps, CHAIN_ID);
    expect(result.stage).toBe("verified");
  });
});
