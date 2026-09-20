import {describe, expect, it} from "vitest";
import {hashTypedData, recoverTypedDataAddress} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import type {Address, Hex} from "viem";
import {
  MOBILE_BOOKING_PRIMARY_TYPE,
  MOBILE_BOOKING_TYPES,
  canonicalPayloadJson,
  decodeMobileBookingPayload,
  fromWireMessage,
  mobileBookingPayloadSchema,
  toWireMessage,
} from "@/lib/booking/mobileEip712";
import vectors from "../vectors/eip712-mobile-booking-vectors.json";

/**
 * `tests/unit/eip712MobileBooking.vectors.test.ts` pins the fixture against a SEPARATE,
 * independently-hardcoded `TYPES` copy it defines for itself (by design - see that file's own doc
 * comment, mirroring `eip712ClientRegistration.vectors.test.ts`). That leaves this app's actual
 * production struct definition (`MOBILE_BOOKING_TYPES` below, what the real booking route
 * signs/recovers against) completely unguarded: a typo here could pass every existing test while
 * silently producing a digest no vector agrees with. This file closes that gap by feeding the SAME
 * fixture through THIS module's own types/domain/message-conversion functions - directly mirroring
 * `tests/unit/registration/eip712.test.ts`'s structure for `ClientRegistration`.
 */
interface MobileBookingVector {
  name: string;
  domain: {name: string; version: string; chainId: number; verifyingContract: Address};
  message: {clinic: Address; bookingHash: Hex; wallet: Address; issuedAt: string; deadline: string};
  expected: {domainSeparator: Hex; structHash: Hex; digest: Hex};
}

const typedVectors = vectors as unknown as MobileBookingVector[];

describe("MOBILE_BOOKING_TYPES (production struct) against the shared fixture", () => {
  it.each(typedVectors.map((v) => [v.name, v] as const))(
    "%s: hashTypedData through the PRODUCTION types/message-conversion matches the fixture's digest",
    (_name, vector) => {
      const message = fromWireMessage(vector.message);
      const digest = hashTypedData({
        domain: vector.domain,
        types: MOBILE_BOOKING_TYPES,
        primaryType: MOBILE_BOOKING_PRIMARY_TYPE,
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
      bookingHash: `0x${"0".repeat(64)}` as Hex,
      wallet: "0x0000000000000000000000000000000000000000",
      issuedAt: uint64Max,
      deadline: uint64Max,
    });
    expect(message.issuedAt).toBe(2n ** 64n - 1n);
    expect(toWireMessage(message).issuedAt).toBe(uint64Max);
  });
});

describe("canonicalPayloadJson / decodeMobileBookingPayload", () => {
  it("produces valid JSON that decodeMobileBookingPayload accepts, for every vector", () => {
    for (const vector of typedVectors) {
      const json = canonicalPayloadJson(
        {name: "DogTagMobileBooking", version: "1", chainId: vector.domain.chainId, verifyingContract: vector.domain.verifyingContract},
        vector.message,
      );
      const decoded = decodeMobileBookingPayload(json);
      expect(decoded).not.toBeNull();
      expect(decoded!.message.bookingHash.toLowerCase()).toBe(vector.message.bookingHash.toLowerCase());
      expect(decoded!.domain.verifyingContract.toLowerCase()).toBe(vector.domain.verifyingContract.toLowerCase());
    }
  });

  it("is deterministic and produces no whitespace", () => {
    const domain = {name: "DogTagMobileBooking", version: "1", chainId: 135, verifyingContract: "0x0000000000000000000000000000000000000000"} as const;
    const message = typedVectors[0]?.message;
    if (!message) throw new Error("expected at least one vector");
    const a = canonicalPayloadJson(domain, message);
    const b = canonicalPayloadJson(domain, message);
    expect(a).toBe(b);
    expect(a).not.toMatch(/\s/);
  });

  it("rejects a ClientRegistration-shaped payload (wrong domain name)", () => {
    const badJson = JSON.stringify({
      domain: {name: "DogTagClientRegistration", version: "1", chainId: 135, verifyingContract: "0x0000000000000000000000000000000000000000"},
      message: {clinic: "0x0000000000000000000000000000000000000000", bookingHash: `0x${"0".repeat(64)}`, wallet: "0x0000000000000000000000000000000000000000", issuedAt: "0", deadline: "0"},
    });
    expect(decodeMobileBookingPayload(badJson)).toBeNull();
    expect(mobileBookingPayloadSchema.safeParse(JSON.parse(badJson)).success).toBe(false);
  });

  it("decodeMobileBookingPayload tolerates malformed JSON without throwing", () => {
    expect(decodeMobileBookingPayload("not json")).toBeNull();
  });
});

describe("a real sign + recover round trip through the production types (no server, no mocks)", () => {
  it("recovers the exact signer for a freshly generated key, reusing an extreme (uint64-max) vector's other fields", async () => {
    const vector = typedVectors.find((v) => v.name === "both-uint64-fields-max");
    if (!vector) throw new Error("expected the both-uint64-fields-max vector to exist");

    const account = privateKeyToAccount(generatePrivateKey());
    const domain = vector.domain;
    const message = fromWireMessage({...vector.message, wallet: account.address});

    const signature = await account.signTypedData({
      domain,
      types: MOBILE_BOOKING_TYPES,
      primaryType: MOBILE_BOOKING_PRIMARY_TYPE,
      message,
    });
    const recovered = await recoverTypedDataAddress({
      domain,
      types: MOBILE_BOOKING_TYPES,
      primaryType: MOBILE_BOOKING_PRIMARY_TYPE,
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
      types: MOBILE_BOOKING_TYPES,
      primaryType: MOBILE_BOOKING_PRIMARY_TYPE,
      message: signedMessage,
    });

    const messageAsClaimed = fromWireMessage({...vector.message, wallet: claimedWallet});
    const recovered = await recoverTypedDataAddress({
      domain,
      types: MOBILE_BOOKING_TYPES,
      primaryType: MOBILE_BOOKING_PRIMARY_TYPE,
      message: messageAsClaimed,
      signature,
    });
    expect(recovered.toLowerCase()).not.toBe(claimedWallet.toLowerCase());
  });
});
