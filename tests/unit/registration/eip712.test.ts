import {describe, expect, it} from "vitest";
import {hashTypedData, recoverTypedDataAddress} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import type {Address, Hex} from "viem";
import {
  CLIENT_REGISTRATION_PRIMARY_TYPE,
  CLIENT_REGISTRATION_TYPES,
  canonicalPayloadJson,
  clientRegistrationPayloadSchema,
  fromWireMessage,
  toWireMessage,
} from "@/lib/registration/eip712";
import vectors from "../vectors/eip712-client-registration-vectors.json";

/**
 * `tests/unit/eip712ClientRegistration.vectors.test.ts` pins the fixture against a SEPARATE,
 * independently-hardcoded `TYPES` copy it defines for itself - by design, per that file's own doc
 * comment, it never imports from this app's source at all. That leaves this app's actual
 * production struct definition (`CLIENT_REGISTRATION_TYPES` below, what every real route
 * signs/recovers against) completely unguarded: a typo here could pass every existing test while
 * silently producing a digest no vector agrees with. This file closes that gap by feeding the
 * SAME fixture through THIS module's own types/domain/message-conversion functions.
 */
interface ClientRegistrationVector {
  name: string;
  domain: {name: string; version: string; chainId: number; verifyingContract: Address};
  message: {
    clinic: Address;
    clientHash: Hex;
    registrationId: Hex;
    wallet: Address;
    issuedAt: string;
    blockNumber: string;
    deadline: string;
  };
  expected: {domainSeparator: Hex; structHash: Hex; digest: Hex};
}

const typedVectors = vectors as unknown as ClientRegistrationVector[];

describe("CLIENT_REGISTRATION_TYPES (production struct) against the shared fixture", () => {
  it.each(typedVectors.map((v) => [v.name, v] as const))(
    "%s: hashTypedData through the PRODUCTION types/message-conversion matches the fixture's digest",
    (_name, vector) => {
      const message = fromWireMessage(vector.message);
      const digest = hashTypedData({
        domain: vector.domain,
        types: CLIENT_REGISTRATION_TYPES,
        primaryType: CLIENT_REGISTRATION_PRIMARY_TYPE,
        message,
      });
      expect(digest).toBe(vector.expected.digest);
    },
  );
});

describe("toWireMessage / fromWireMessage round trip", () => {
  it("round-trips every vector's message through bigint and back to the identical wire strings", () => {
    for (const vector of typedVectors) {
      const roundTripped = toWireMessage(fromWireMessage(vector.message));
      expect(roundTripped).toEqual(vector.message);
    }
  });

  it("round-trips 2^64-1 without precision loss (the case Number() would silently corrupt)", () => {
    const uint64Max = "18446744073709551615";
    const message = fromWireMessage({
      clinic: "0x0000000000000000000000000000000000000000",
      clientHash: `0x${"0".repeat(64)}` as Hex,
      registrationId: `0x${"0".repeat(64)}` as Hex,
      wallet: "0x0000000000000000000000000000000000000000",
      issuedAt: uint64Max,
      blockNumber: uint64Max,
      deadline: uint64Max,
    });
    expect(message.issuedAt).toBe(2n ** 64n - 1n);
    expect(toWireMessage(message).issuedAt).toBe(uint64Max);
  });
});

describe("canonicalPayloadJson", () => {
  it("produces valid JSON that clientRegistrationPayloadSchema accepts, for every vector", () => {
    for (const vector of typedVectors) {
      const json = canonicalPayloadJson(
        {name: "DogTagClientRegistration", version: "1", chainId: vector.domain.chainId, verifyingContract: vector.domain.verifyingContract},
        vector.message,
      );
      const parsed = clientRegistrationPayloadSchema.parse(JSON.parse(json));
      expect(parsed.domain.verifyingContract.toLowerCase()).toBe(vector.domain.verifyingContract.toLowerCase());
      expect(parsed.message.clientHash.toLowerCase()).toBe(vector.message.clientHash.toLowerCase());
    }
  });

  it("is deterministic and produces no whitespace", () => {
    const domain = {name: "DogTagClientRegistration", version: "1", chainId: 135, verifyingContract: "0x0000000000000000000000000000000000000000"} as const;
    const message = typedVectors[0]?.message;
    if (!message) throw new Error("expected at least one vector");
    const a = canonicalPayloadJson(domain, message);
    const b = canonicalPayloadJson(domain, message);
    expect(a).toBe(b);
    expect(a).not.toMatch(/\s/);
  });

  it("changes when any single field changes", () => {
    const domain = {name: "DogTagClientRegistration", version: "1", chainId: 135, verifyingContract: "0x0000000000000000000000000000000000000000"} as const;
    const message = typedVectors[0]?.message;
    if (!message) throw new Error("expected at least one vector");
    const base = canonicalPayloadJson(domain, message);
    expect(canonicalPayloadJson({...domain, chainId: 999}, message)).not.toBe(base);
    expect(canonicalPayloadJson(domain, {...message, deadline: "1"})).not.toBe(base);
  });
});

describe("a real sign + recover round trip through the production types (no server, no mocks)", () => {
  it("recovers the exact signer for a freshly generated key, reusing an extreme (uint64-max) vector's other fields", async () => {
    const vector = typedVectors.find((v) => v.name === "all-uint64-fields-max");
    if (!vector) throw new Error("expected the all-uint64-fields-max vector to exist");

    const account = privateKeyToAccount(generatePrivateKey());
    const domain = vector.domain;
    const message = fromWireMessage({...vector.message, wallet: account.address});

    // Deliberately NOT `signTypedDataAsync` from wagmi (browser-only) - `account.signTypedData` is
    // the same underlying viem primitive, callable directly in a Node test, exactly the way
    // `Eip712.swift` on the iOS side and this repo's own `recoverTypedDataAddress` calls are
    // exercised without a browser anywhere in the loop.
    const signature = await account.signTypedData({
      domain,
      types: CLIENT_REGISTRATION_TYPES,
      primaryType: CLIENT_REGISTRATION_PRIMARY_TYPE,
      message,
    });
    const recovered = await recoverTypedDataAddress({
      domain,
      types: CLIENT_REGISTRATION_TYPES,
      primaryType: CLIENT_REGISTRATION_PRIMARY_TYPE,
      message,
      signature,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("a signature over a DIFFERENT wallet value recovers to something other than the claimed wallet", async () => {
    const vector = typedVectors.find((v) => v.name === "baseline");
    if (!vector) throw new Error("expected the baseline vector to exist");

    const signer = privateKeyToAccount(generatePrivateKey());
    const claimedWallet = privateKeyToAccount(generatePrivateKey()).address; // NOT the signer

    const domain = vector.domain;
    const signedMessage = fromWireMessage({...vector.message, wallet: signer.address});
    const signature = await signer.signTypedData({
      domain,
      types: CLIENT_REGISTRATION_TYPES,
      primaryType: CLIENT_REGISTRATION_PRIMARY_TYPE,
      message: signedMessage,
    });

    // A server rebuilding the message around the REQUEST's claimed `wallet` (not the signer's own
    // address) recomputes a DIFFERENT struct hash, so the recovered address is neither the signer
    // nor (except by 2^-160 chance) the claimed wallet - this is what makes "recovered MUST equal
    // wallet" a real check rather than a tautology.
    const messageAsClaimed = fromWireMessage({...vector.message, wallet: claimedWallet});
    const recovered = await recoverTypedDataAddress({
      domain,
      types: CLIENT_REGISTRATION_TYPES,
      primaryType: CLIENT_REGISTRATION_PRIMARY_TYPE,
      message: messageAsClaimed,
      signature,
    });
    expect(recovered.toLowerCase()).not.toBe(claimedWallet.toLowerCase());
  });
});
