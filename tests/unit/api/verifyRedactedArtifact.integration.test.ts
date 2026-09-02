import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import mongoose from "mongoose";
import {buildMerkle, hashLeaf, hexToBytes, toHex32, TypeTag, type TypedScalar} from "@dogtag/standard";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.10V item 5 - `POST /api/verify/redacted-artifact`, against the REAL route handler. The
 * verification PIPELINE itself (every stage: crypto_failed, malformed_claim, chain_unreadable,
 * not_anchored x2, chain_anchored_issuer_unknown, verified x2) is already thoroughly unit-tested
 * against an in-memory fake in `tests/unit/tags/verifyRedactedFlow.test.ts` - this file proves the
 * ROUTE's own wiring: auth gate, registry-first shape validation with field errors, and that a
 * genuinely valid submission reaches the real pipeline end to end (using the UNCONFIGURED chain
 * deps path - no DOGTAG_SBT_ADDRESS/VET_ISSUER_FACTORY_ADDRESS env vars set - which legitimately
 * makes every chain read reject, so a crypto-valid artifact should surface as chain_unreadable;
 * this exercises the real code path without inventing a new chainRead.ts mocking convention this
 * repo has no precedent for).
 *
 * ISOLATION: own ephemeral mongod, port 44132 (44117-44131 already taken by sibling suites - see
 * `tests/unit/api/exportTagDataFields.integration.test.ts`'s own doc comment).
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));

import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {POST} from "@/app/api/verify/redacted-artifact/route";

const MONGO_PORT = 44_132;
let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-verify-redacted");
  process.env.MONGODB_URI = ephemeral.uri;
  delete process.env.DOGTAG_SBT_ADDRESS;
  delete process.env.VET_ISSUER_FACTORY_ADDRESS;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  expect(mongoose.connection.name).toBe("dogtag-vet-verify-redacted");
}, 30_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(() => {
  vi.mocked(auth).mockReset();
});

function staffSession() {
  vi.mocked(auth).mockResolvedValue({user: {staffId: "staff-1", email: "staff@example.com"}} as never);
}

function postRequest(body: unknown) {
  return POST(
    new Request("https://vet.example.com/api/verify/redacted-artifact", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    }),
  );
}

/** A genuine, hashLeaf/buildMerkle-verifiable artifact. */
function buildVerifiableArtifact(dogTagIdField: string) {
  const salt = (n: number) => new Uint8Array(16).fill(n);
  const saltHexOf = (n: number) => ("0x" + Array.from(salt(n)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
  const disclosed = [
    {keyPath: "credentialSubject.name", saltHex: saltHexOf(11), tag: TypeTag.String, value: "Rex"},
    {keyPath: "owner.identity.fullName", saltHex: saltHexOf(12), tag: TypeTag.String, value: "Jane Doe"},
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
    dogTagIdField,
    root,
    disclosed,
    obfuscatedLeafHashes: [] as string[],
    reservedLeafHashes,
    issuerClone: "0x57f8786264c55cdd8f3ece0ba177f6ad2df90e0",
  };
}

describe("POST /api/verify/redacted-artifact", () => {
  it("401 when not signed in", async () => {
    const res = await postRequest({});
    expect(res.status).toBe(401);
  });

  it("400 with field errors for a shape that is not a RedactedTagArtifact at all", async () => {
    staffSession();
    const res = await postRequest({not: "an artifact"});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.details.fieldErrors).toBeDefined();
  });

  it("400 when reservedLeafHashes does not have exactly 3 entries", async () => {
    staffSession();
    const artifact = buildVerifiableArtifact("123456789");
    const res = await postRequest({...artifact, reservedLeafHashes: artifact.reservedLeafHashes.slice(0, 2)});
    expect(res.status).toBe(400);
  });

  it("a genuinely valid, crypto-passing artifact reaches the real pipeline end to end - chain_unreadable with this deployment unconfigured", async () => {
    staffSession();
    const artifact = buildVerifiableArtifact("123456789");
    const res = await postRequest(artifact);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toEqual({stage: "chain_unreadable"});
    expect(body.disclosedKeyPaths).toEqual(["credentialSubject.name", "owner.identity.fullName"]);
    expect(body.obfuscatedCount).toBe(0);
    expect(body.reservedCount).toBe(3);
  });

  it("a tampered artifact never even reaches the chain-read stage - crypto_failed, not chain_unreadable", async () => {
    staffSession();
    const artifact = buildVerifiableArtifact("123456789");
    const tampered = {...artifact, disclosed: [{...artifact.disclosed[0]!, value: "Someone Else"}, artifact.disclosed[1]!]};
    const res = await postRequest(tampered);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toEqual({stage: "crypto_failed"});
  });
});
