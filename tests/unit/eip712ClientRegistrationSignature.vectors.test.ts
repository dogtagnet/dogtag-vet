import {describe, expect, it} from "vitest";
import {hashTypedData, isHex, recoverAddress, size} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import type {Address, Hex} from "viem";
import vectors from "./vectors/eip712-client-registration-signature-vectors.json";

/**
 * WP4.5 track3-sig fix 5 - the cross-repo SIGNATURE vectors file, distinct from (and a companion
 * to) `eip712-client-registration-vectors.json`/`eip712ClientRegistration.vectors.test.ts`: that
 * file pins `domainSeparator`/`structHash`/`digest` against an ALREADY-bytes32 `message`, so it can
 * never catch a bug in the WIRE-FORMAT conversion step (a device's `GET /w/:token` response has a
 * DASHED `registrationId` string, folded to bytes32 only when building the signed struct - see
 * `lib/registration/uuid.ts`'s `registrationIdToHex32`). This file's vectors instead carry a
 * `challenge` shaped exactly like that wire response, PLUS a `privateKey` and the expected 65-byte
 * signature - covering the full chain "wire challenge -> struct -> digest -> signature", and
 * deliberately including both ECDSA recovery-id branches (v=27 and v=28): a byte-exact
 * implementation must treat both identically, and a subtle recovery-id bug (an off-by-one, or a
 * hardcoded assumption of one branch) would otherwise only show up on whichever branch a random
 * real-world key happened to land on.
 *
 * Generated once with this repo's own installed viem (2.56.0) - see this describe block's own
 * `it`s below for viem independently recomputing (not merely echoing) every value - and checked
 * into both repos byte-identical: here, and `dogtag-ios/DogTagTests/Fixtures/` (verified with
 * `cmp` at generation time), where `Eip712SignatureVectorsTests.swift` drives the REAL
 * `RegistrationFlowEngine.buildSigningPayload -> Eip712.digest -> Secp256k1.signDigest` path
 * against the same fixture.
 */

const PRIMARY_TYPE = "ClientRegistration" as const;
const TYPES = {
  ClientRegistration: [
    {name: "clinic", type: "address"},
    {name: "clientHash", type: "bytes32"},
    {name: "registrationId", type: "bytes32"},
    {name: "wallet", type: "address"},
    {name: "issuedAt", type: "uint64"},
    {name: "blockNumber", type: "uint64"},
    {name: "deadline", type: "uint64"},
  ],
} as const;

function registrationIdToHex32(dashedUuid: string): Hex {
  const hex = dashedUuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`not a UUID shape: ${dashedUuid}`);
  return `0x${hex.toLowerCase()}${"0".repeat(32)}` as Hex;
}

interface SignatureVector {
  name: string;
  description: string;
  privateKey: Hex;
  challenge: {
    clinicName: string;
    clone: Address;
    chainId: number;
    maskedClientName: string;
    clientHash: Hex;
    registrationId: string; // DASHED uuid string - the actual GET /w/:token wire shape
    issuedAt: string;
    blockNumber: string;
    deadline: string;
    ttlSecs: number;
  };
  wallet: Address;
  expected: {digest: Hex; signature: Hex; v: number};
}

const typedVectors = vectors as unknown as SignatureVector[];

function buildDomainAndMessage(vector: SignatureVector) {
  const domain = {
    name: "DogTagClientRegistration" as const,
    version: "1" as const,
    chainId: vector.challenge.chainId,
    verifyingContract: vector.challenge.clone,
  };
  const message = {
    clinic: vector.challenge.clone,
    clientHash: vector.challenge.clientHash,
    registrationId: registrationIdToHex32(vector.challenge.registrationId),
    wallet: vector.wallet,
    issuedAt: BigInt(vector.challenge.issuedAt),
    blockNumber: BigInt(vector.challenge.blockNumber),
    deadline: BigInt(vector.challenge.deadline),
  };
  return {domain, message};
}

describe("tests/unit/vectors/eip712-client-registration-signature-vectors.json", () => {
  it("has at least 6 vectors", () => {
    expect(typedVectors.length).toBeGreaterThanOrEqual(6);
  });

  it("covers BOTH v=27 and v=28", () => {
    const vs = new Set(typedVectors.map((v) => v.expected.v));
    expect(vs.has(27)).toBe(true);
    expect(vs.has(28)).toBe(true);
    expect(typedVectors.every((v) => v.expected.v === 27 || v.expected.v === 28)).toBe(true);
  });

  it("every vector's recorded v matches the LAST BYTE of its own expected signature (0x1b=27, 0x1c=28)", () => {
    for (const vector of typedVectors) {
      const vByte = vector.expected.signature.slice(-2);
      expect(parseInt(vByte, 16), vector.name).toBe(vector.expected.v);
    }
  });

  it("privateKey, wallet, and clone/clientHash/registrationId are all well-formed (32-byte key, 20-byte addresses, 32-byte hash)", () => {
    for (const vector of typedVectors) {
      expect(isHex(vector.privateKey) && size(vector.privateKey) === 32, `${vector.name}: privateKey`).toBe(true);
      expect(isHex(vector.wallet) && size(vector.wallet) === 20, `${vector.name}: wallet`).toBe(true);
      expect(isHex(vector.challenge.clone) && size(vector.challenge.clone) === 20, `${vector.name}: clone`).toBe(true);
      expect(isHex(vector.challenge.clientHash) && size(vector.challenge.clientHash) === 32, `${vector.name}: clientHash`).toBe(true);
      expect(isHex(vector.expected.signature) && size(vector.expected.signature) === 65, `${vector.name}: signature`).toBe(true);
    }
  });

  it("gives every vector a unique name and a unique digest", () => {
    expect(new Set(typedVectors.map((v) => v.name)).size).toBe(typedVectors.length);
    expect(new Set(typedVectors.map((v) => v.expected.digest)).size).toBe(typedVectors.length);
  });

  it.each(typedVectors.map((v) => [v.name, v] as const))(
    "%s: the wallet address is derived from the private key",
    (_name, vector) => {
      expect(privateKeyToAccount(vector.privateKey).address.toLowerCase()).toBe(vector.wallet.toLowerCase());
    },
  );

  it.each(typedVectors.map((v) => [v.name, v] as const))(
    "%s: viem independently recomputes the digest from the DASHED wire challenge, matching expected.digest",
    (_name, vector) => {
      const {domain, message} = buildDomainAndMessage(vector);
      const digest = hashTypedData({domain, types: TYPES, primaryType: PRIMARY_TYPE, message});
      expect(digest).toBe(vector.expected.digest);
    },
  );

  it.each(typedVectors.map((v) => [v.name, v] as const))(
    "%s: recovering expected.signature against expected.digest yields exactly this vector's wallet",
    async (_name, vector) => {
      const recovered = await recoverAddress({hash: vector.expected.digest, signature: vector.expected.signature});
      expect(recovered.toLowerCase()).toBe(vector.wallet.toLowerCase());
    },
  );

  it.each(typedVectors.map((v) => [v.name, v] as const))(
    "%s: re-signing with the SAME private key over the SAME message deterministically reproduces expected.signature byte-for-byte",
    async (_name, vector) => {
      const {domain, message} = buildDomainAndMessage(vector);
      const account = privateKeyToAccount(vector.privateKey);
      const signature = await account.signTypedData({domain, types: TYPES, primaryType: PRIMARY_TYPE, message});
      expect(signature).toBe(vector.expected.signature);
    },
  );
});
