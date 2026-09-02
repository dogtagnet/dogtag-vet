import {describe, expect, it, vi} from "vitest";
import {buildMerkle, dogTagIdField, hashLeaf, hexToBytes, toHex32, TypeTag, type RedactedTagArtifact, type TypedScalar} from "@dogtag/standard";
import type {TagDataChainDeps} from "@/lib/tags/verifier";
import {verifyRedactedArtifactSubmission} from "@/lib/tags/verifyRedactedFlow";

const FOREIGN_CLONE = "0x57f8786264c55cdd8f3ece0ba177f6ad2df90e0";
const ZERO_HEX32 = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DOG_TAG_ID_DEC = "42";
const DOG_TAG_ID_FIELD = dogTagIdField(DOG_TAG_ID_DEC).toString(10);

function fakeDeps(overrides: Partial<TagDataChainDeps> = {}): TagDataChainDeps {
  return {
    readProfileRoot: vi.fn().mockResolvedValue(ZERO_HEX32),
    readRootIssuer: vi.fn().mockResolvedValue(ZERO_ADDRESS),
    readIsValidRoot: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

/** A genuine, hashLeaf/buildMerkle-verifiable artifact - same fixture convention as every other
 * test file touching verifyRedactedArtifact in this repo. */
function buildVerifiableArtifact(overrides: Partial<RedactedTagArtifact> = {}): RedactedTagArtifact {
  const salt = (n: number) => new Uint8Array(16).fill(n);
  const saltHexOf = (n: number) => ("0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
  const disclosed = [
    {keyPath: "credentialSubject.name", saltHex: saltHexOf(11), tag: TypeTag.String, value: "Rex"},
    {keyPath: "credentialSubject.species", saltHex: saltHexOf(12), tag: TypeTag.String, value: "dog"},
  ];
  const reservedLeafHashes = [
    toHex32(hashLeaf("owner.address", salt(201), {tag: TypeTag.Bytes, value: new Uint8Array([1])} as TypedScalar)),
    toHex32(hashLeaf("owner.consentKey", salt(202), {tag: TypeTag.Bytes, value: new Uint8Array([2])} as TypedScalar)),
    toHex32(hashLeaf("owner.secret", salt(203), {tag: TypeTag.Bytes, value: new Uint8Array([3])} as TypedScalar)),
  ];
  const reservedFields = reservedLeafHashes.map((h) => BigInt(h));
  const leafFields = disclosed.map((l) => hashLeaf(l.keyPath, hexToBytes(l.saltHex), {tag: l.tag, value: l.value} as TypedScalar));
  const root = toHex32(buildMerkle([...reservedFields, ...leafFields]).root);
  return {
    protocolVersion: "dogtag-v2/1",
    dogTagIdField: DOG_TAG_ID_FIELD,
    root,
    disclosed,
    obfuscatedLeafHashes: [],
    reservedLeafHashes,
    issuerClone: FOREIGN_CLONE,
    ...overrides,
  };
}

describe("verifyRedactedArtifactSubmission (WP4.10V item 5's verify-page pipeline)", () => {
  it("crypto_failed: a tampered artifact never reaches the chain at all", async () => {
    const artifact = buildVerifiableArtifact({disclosed: [{keyPath: "credentialSubject.name", saltHex: `0x${"aa".repeat(16)}`, tag: TypeTag.String, value: "Tampered"}]});
    const deps = fakeDeps();
    const result = await verifyRedactedArtifactSubmission(artifact, deps);
    expect(result).toEqual({stage: "crypto_failed"});
    expect(deps.readProfileRoot).not.toHaveBeenCalled();
  });

  it("malformed_claim: dogTagIdDec/dogTagIdField internally inconsistent", async () => {
    const artifact = buildVerifiableArtifact({dogTagIdDec: "999999999"}); // does not derive DOG_TAG_ID_FIELD
    const deps = fakeDeps();
    const result = await verifyRedactedArtifactSubmission(artifact, deps);
    expect(result).toEqual({stage: "malformed_claim"});
  });

  it("chain_unreadable: readProfileRoot throws - distinct from crypto_failed even though the document is genuinely valid", async () => {
    const artifact = buildVerifiableArtifact();
    const deps = fakeDeps({readProfileRoot: vi.fn().mockRejectedValue(new Error("RPC timeout"))});
    const result = await verifyRedactedArtifactSubmission(artifact, deps);
    expect(result).toEqual({stage: "chain_unreadable"});
  });

  it("chain_unreadable: readIsValidRoot throws AFTER the root already matched - still chain_unreadable, not verified:false", async () => {
    const artifact = buildVerifiableArtifact();
    const deps = fakeDeps({
      readProfileRoot: vi.fn().mockResolvedValue(artifact.root),
      readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE),
      readIsValidRoot: vi.fn().mockRejectedValue(new Error("RPC timeout")),
    });
    const result = await verifyRedactedArtifactSubmission(artifact, deps);
    expect(result).toEqual({stage: "chain_unreadable"});
  });

  it("not_anchored/never_issued: the chain was read fine, but this dogTagId has never been issued (live root is zero)", async () => {
    const artifact = buildVerifiableArtifact();
    const deps = fakeDeps(); // readProfileRoot defaults to ZERO_HEX32
    const result = await verifyRedactedArtifactSubmission(artifact, deps);
    expect(result).toEqual({stage: "not_anchored", reason: "never_issued"});
    expect(deps.readRootIssuer).not.toHaveBeenCalled();
  });

  it("not_anchored/root_mismatch: the chain is anchored, but to a DIFFERENT root than this artifact claims", async () => {
    const artifact = buildVerifiableArtifact();
    const liveButDifferentRoot = `0x${"77".repeat(32)}`;
    const deps = fakeDeps({
      readProfileRoot: vi.fn().mockResolvedValue(liveButDifferentRoot),
      readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE),
    });
    const result = await verifyRedactedArtifactSubmission(artifact, deps);
    expect(result).toEqual({stage: "not_anchored", reason: "root_mismatch"});
    // isValid is never even read - there is no point checking validity of a root this artifact
    // does not actually claim to be.
    expect(deps.readIsValidRoot).not.toHaveBeenCalled();
  });

  it("chain_anchored_issuer_unknown: defensive - a nonzero live root with no indexed issuer", async () => {
    const artifact = buildVerifiableArtifact();
    const deps = fakeDeps({
      readProfileRoot: vi.fn().mockResolvedValue(artifact.root),
      readRootIssuer: vi.fn().mockResolvedValue(ZERO_ADDRESS),
    });
    const result = await verifyRedactedArtifactSubmission(artifact, deps);
    expect(result).toEqual({stage: "chain_anchored_issuer_unknown"});
  });

  it("verified, isValid true: the fully happy path", async () => {
    const artifact = buildVerifiableArtifact();
    const deps = fakeDeps({
      readProfileRoot: vi.fn().mockResolvedValue(artifact.root),
      readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE),
      readIsValidRoot: vi.fn().mockResolvedValue(true),
    });
    const result = await verifyRedactedArtifactSubmission(artifact, deps);
    expect(result).toEqual({stage: "verified", issuerClone: FOREIGN_CLONE.toLowerCase(), isValid: true});
  });

  it("verified, isValid false: genuinely anchored and issued, but currently revoked/invalid - still 'verified' stage, honest isValid flag", async () => {
    const artifact = buildVerifiableArtifact();
    const deps = fakeDeps({
      readProfileRoot: vi.fn().mockResolvedValue(artifact.root),
      readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE),
      readIsValidRoot: vi.fn().mockResolvedValue(false),
    });
    const result = await verifyRedactedArtifactSubmission(artifact, deps);
    expect(result).toEqual({stage: "verified", issuerClone: FOREIGN_CLONE.toLowerCase(), isValid: false});
  });

  it("a MASKED artifact (some leaves obfuscated) still verifies through the full pipeline", async () => {
    const base = buildVerifiableArtifact();
    const [disclosedLeaf, maskedLeaf] = base.disclosed;
    const maskedHash = toHex32(hashLeaf(maskedLeaf!.keyPath, hexToBytes(maskedLeaf!.saltHex), {tag: maskedLeaf!.tag, value: maskedLeaf!.value} as TypedScalar));
    const artifact: RedactedTagArtifact = {...base, disclosed: [disclosedLeaf!], obfuscatedLeafHashes: [maskedHash]};
    const deps = fakeDeps({
      readProfileRoot: vi.fn().mockResolvedValue(artifact.root), // masking never moves the root
      readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE),
      readIsValidRoot: vi.fn().mockResolvedValue(true),
    });
    const result = await verifyRedactedArtifactSubmission(artifact, deps);
    expect(result).toEqual({stage: "verified", issuerClone: FOREIGN_CLONE.toLowerCase(), isValid: true});
  });

  it("a FULLY masked artifact (disclosed: []) still verifies - the falsifiable non-maskable-set-empty demonstration, at the verify-page layer too", async () => {
    const base = buildVerifiableArtifact();
    const allHashes = base.disclosed.map((l) => toHex32(hashLeaf(l.keyPath, hexToBytes(l.saltHex), {tag: l.tag, value: l.value} as TypedScalar)));
    const artifact: RedactedTagArtifact = {...base, disclosed: [], obfuscatedLeafHashes: allHashes};
    const deps = fakeDeps({
      readProfileRoot: vi.fn().mockResolvedValue(artifact.root),
      readRootIssuer: vi.fn().mockResolvedValue(FOREIGN_CLONE),
      readIsValidRoot: vi.fn().mockResolvedValue(true),
    });
    const result = await verifyRedactedArtifactSubmission(artifact, deps);
    expect(result).toEqual({stage: "verified", issuerClone: FOREIGN_CLONE.toLowerCase(), isValid: true});
  });
});
