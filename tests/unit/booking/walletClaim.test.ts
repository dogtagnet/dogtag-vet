import {describe, expect, it} from "vitest";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import type {Address, Hex} from "viem";
import {MOBILE_BOOKING_PRIMARY_TYPE, MOBILE_BOOKING_TYPES, buildMobileBookingDomain} from "@/lib/booking/mobileEip712";
import {MOBILE_BOOKING_MAX_TTL_SECS, verifyMobileBookingWalletClaim} from "@/lib/booking/walletClaim";

const CHAIN_ID = 135;
const CLINIC: Address = "0x5bd5048125f223100A2753A740f34d044AB493B5";
const BOOKING_HASH: Hex = "0x2e2b3738f773ac21e64f6be41336cfeab2a8b2ef7a38390a5d716bd8b7c3a929";

async function sign(params: {wallet: Address; issuedAt: number; deadline: number; account: ReturnType<typeof privateKeyToAccount>; clinic?: Address; bookingHash?: Hex; chainId?: number}) {
  const domain = buildMobileBookingDomain(params.chainId ?? CHAIN_ID, params.clinic ?? CLINIC);
  const message = {
    clinic: params.clinic ?? CLINIC,
    bookingHash: params.bookingHash ?? BOOKING_HASH,
    wallet: params.wallet,
    issuedAt: BigInt(params.issuedAt),
    deadline: BigInt(params.deadline),
  };
  return params.account.signTypedData({domain, types: MOBILE_BOOKING_TYPES, primaryType: MOBILE_BOOKING_PRIMARY_TYPE, message});
}

describe("verifyMobileBookingWalletClaim", () => {
  const now = 1_800_000_000;

  it("accepts a genuinely signed, fresh claim and returns the lowercased wallet", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const issuedAt = now - 10;
    const deadline = issuedAt + 600;
    const signature = await sign({wallet: account.address, issuedAt, deadline, account});

    const result = await verifyMobileBookingWalletClaim({
      chainId: CHAIN_ID,
      clinicCloneAddress: CLINIC,
      bookingHash: BOOKING_HASH,
      claimedWallet: account.address,
      signature,
      issuedAt,
      deadline,
      now,
    });

    expect(result).toEqual({ok: true, wallet: account.address.toLowerCase()});
  });

  it("rejects a well-formed signature from a DIFFERENT signer than the claimed wallet", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const claimedWallet = privateKeyToAccount(generatePrivateKey()).address; // not the signer
    const issuedAt = now - 10;
    const deadline = issuedAt + 600;
    const signature = await sign({wallet: claimedWallet, issuedAt, deadline, account: signer});

    const result = await verifyMobileBookingWalletClaim({
      chainId: CHAIN_ID,
      clinicCloneAddress: CLINIC,
      bookingHash: BOOKING_HASH,
      claimedWallet,
      signature,
      issuedAt,
      deadline,
      now,
    });

    expect(result).toEqual({ok: false, reason: "signature_invalid"});
  });

  it("rejects a signature bound to a DIFFERENT bookingHash (replay onto another booking's content)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const issuedAt = now - 10;
    const deadline = issuedAt + 600;
    const signature = await sign({wallet: account.address, issuedAt, deadline, account, bookingHash: "0x0000000000000000000000000000000000000000000000000000000000000001"});

    const result = await verifyMobileBookingWalletClaim({
      chainId: CHAIN_ID,
      clinicCloneAddress: CLINIC,
      bookingHash: BOOKING_HASH, // server recomputed a DIFFERENT hash than what was signed
      claimedWallet: account.address,
      signature,
      issuedAt,
      deadline,
      now,
    });

    expect(result).toEqual({ok: false, reason: "signature_invalid"});
  });

  it("rejects a signature bound to a DIFFERENT clinic clone (cross-clinic replay)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const issuedAt = now - 10;
    const deadline = issuedAt + 600;
    const otherClinic: Address = "0x57f8786264C55cDD8f3ECe0Ba177f6AD2dF90e04";
    const signature = await sign({wallet: account.address, issuedAt, deadline, account, clinic: otherClinic});

    const result = await verifyMobileBookingWalletClaim({
      chainId: CHAIN_ID,
      clinicCloneAddress: CLINIC, // this clinic's OWN clone - not what was signed
      bookingHash: BOOKING_HASH,
      claimedWallet: account.address,
      signature,
      issuedAt,
      deadline,
      now,
    });

    expect(result).toEqual({ok: false, reason: "signature_invalid"});
  });

  it("rejects a malformed signature outright rather than throwing", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const issuedAt = now - 10;
    const deadline = issuedAt + 600;

    const result = await verifyMobileBookingWalletClaim({
      chainId: CHAIN_ID,
      clinicCloneAddress: CLINIC,
      bookingHash: BOOKING_HASH,
      claimedWallet: account.address,
      signature: `0x${"00".repeat(65)}`,
      issuedAt,
      deadline,
      now,
    });

    expect(result).toEqual({ok: false, reason: "signature_invalid"});
  });

  it("rejects an already-expired claim (now > deadline), even with an otherwise-valid signature", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const issuedAt = now - 700;
    const deadline = issuedAt + 600; // deadline is 100s before `now`
    const signature = await sign({wallet: account.address, issuedAt, deadline, account});

    const result = await verifyMobileBookingWalletClaim({
      chainId: CHAIN_ID,
      clinicCloneAddress: CLINIC,
      bookingHash: BOOKING_HASH,
      claimedWallet: account.address,
      signature,
      issuedAt,
      deadline,
      now,
    });

    expect(result).toEqual({ok: false, reason: "expired"});
  });

  it("rejects a claim whose window (deadline - issuedAt) exceeds the max TTL, even if not yet expired", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const issuedAt = now - 10;
    const deadline = issuedAt + MOBILE_BOOKING_MAX_TTL_SECS + 1; // one second over the 10-minute cap
    const signature = await sign({wallet: account.address, issuedAt, deadline, account});

    const result = await verifyMobileBookingWalletClaim({
      chainId: CHAIN_ID,
      clinicCloneAddress: CLINIC,
      bookingHash: BOOKING_HASH,
      claimedWallet: account.address,
      signature,
      issuedAt,
      deadline,
      now,
    });

    expect(result).toEqual({ok: false, reason: "window_too_long"});
  });

  it("rejects a nonsensical claim where deadline is not after issuedAt", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const issuedAt = now;
    const deadline = now; // not strictly after issuedAt
    const signature = await sign({wallet: account.address, issuedAt, deadline, account});

    const result = await verifyMobileBookingWalletClaim({
      chainId: CHAIN_ID,
      clinicCloneAddress: CLINIC,
      bookingHash: BOOKING_HASH,
      claimedWallet: account.address,
      signature,
      issuedAt,
      deadline,
      now,
    });

    expect(result).toEqual({ok: false, reason: "deadline_before_issued_at"});
  });

  it("rejects a claim issued too far in the future to be honest clock skew (a year-out issuedAt with a short window, exploiting deadline > now alone)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const issuedAt = now + 365 * 24 * 60 * 60;
    const deadline = issuedAt + 600;
    const signature = await sign({wallet: account.address, issuedAt, deadline, account});

    const result = await verifyMobileBookingWalletClaim({
      chainId: CHAIN_ID,
      clinicCloneAddress: CLINIC,
      bookingHash: BOOKING_HASH,
      claimedWallet: account.address,
      signature,
      issuedAt,
      deadline,
      now,
    });

    expect(result).toEqual({ok: false, reason: "issued_in_future"});
  });

  it("tolerates a small, honest clock-skew window (issuedAt a few seconds ahead of server now)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const issuedAt = now + 5;
    const deadline = issuedAt + 600;
    const signature = await sign({wallet: account.address, issuedAt, deadline, account});

    const result = await verifyMobileBookingWalletClaim({
      chainId: CHAIN_ID,
      clinicCloneAddress: CLINIC,
      bookingHash: BOOKING_HASH,
      claimedWallet: account.address,
      signature,
      issuedAt,
      deadline,
      now,
    });

    expect(result).toEqual({ok: true, wallet: account.address.toLowerCase()});
  });
});
