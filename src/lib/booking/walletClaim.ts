import {recoverTypedDataAddress} from "viem";
import type {Address, Hex} from "viem";
import {MOBILE_BOOKING_PRIMARY_TYPE, MOBILE_BOOKING_TYPES, buildMobileBookingDomain, type MobileBookingMessage} from "@/lib/booking/mobileEip712";

/** The signed claim's max lifetime - plans/wp4.4-mobile-booking-protocol.md section 2: "deadline
 * short (10 min)". Enforced SERVER-SIDE (not merely a convention the app is trusted to follow):
 * without this, an app (or a modified client) could set an arbitrarily distant `deadline` and
 * still pass the bare `now <= deadline` check, defeating the point of a short-lived claim. */
export const MOBILE_BOOKING_MAX_TTL_SECS = 600;

/** How far ahead of the server's own clock an `issuedAt` may honestly be - ordinary clock drift
 * between the app's device and this server, never a real gap. Deliberately small: it exists to
 * tolerate a few seconds of skew, not to open a window a `deadline - issuedAt <= MAX_TTL` check
 * alone would miss (an `issuedAt` set a year out, with a short window immediately after it, still
 * passes the TTL check on its own - this bound closes exactly that gap). */
const CLOCK_SKEW_ALLOWANCE_SECS = 120;

export interface VerifyMobileBookingWalletClaimInput {
  /** The ROAX chain id this deployment is configured for - the domain's `chainId`. */
  chainId: number;
  /** This clinic's OWN `VetIssuer` clone address (`ClinicSettings.cloneAddress`) - the domain's
   * `verifyingContract` AND the struct's in-message `clinic` field. NEVER taken from the wire. */
  clinicCloneAddress: Address;
  /** Server-recomputed over the canonical booking content (`computeMobileBookingHash`) - NEVER
   * taken from the wire. Binds this signature to this booking's exact content. */
  bookingHash: Hex;
  /** The wire's claimed wallet address - the recovered signer MUST equal this. */
  claimedWallet: Address;
  signature: Hex;
  /** Wire values, unix seconds - echoed into the message exactly as claimed (the signature itself
   * is what proves they were not tampered with in transit; a mismatch here just fails to
   * recover to `claimedWallet`, same as any other altered field would). */
  issuedAt: number;
  deadline: number;
  /** Server "now", unix seconds - injected so this stays pure and unit-testable without faking
   * the clock. */
  now: number;
}

export type MobileBookingWalletClaimInvalidReason =
  | "deadline_before_issued_at"
  | "window_too_long"
  | "issued_in_future"
  | "expired"
  | "signature_invalid";

export type VerifyMobileBookingWalletClaimResult =
  | {ok: true; wallet: string} // lowercased
  | {ok: false; reason: MobileBookingWalletClaimInvalidReason};

/**
 * Server verification of a `MobileBooking` signed wallet claim - plans/wp4.4-mobile-booking-
 * protocol.md section 2, mirroring `lib/registration/flow.ts`'s `completeRegistration` idiom
 * exactly (server rebuilds the EXACT domain/message from server-trusted values, never from
 * anything the request supplies except the claimed `wallet` and `signature` themselves, then
 * independently recovers the signer via `recoverTypedDataAddress` and requires it to equal the
 * claimed wallet). Unlike registration's session-based flow, there is no persisted challenge to
 * fetch first - every value this function needs is passed in directly, since a booking is a
 * single-shot request rather than a resolve-then-complete pair.
 *
 * Pure and I/O-free (no chain read, no database) - callers own persistence-side replay protection
 * (deduping on `bookingHash`) separately, since that requires a database this function does not
 * touch. Timestamp checks run BEFORE the (comparatively expensive) signature recovery so an
 * obviously-invalid claim never pays for an EC recovery it cannot use anyway.
 *
 * Per Kenneth's Q2 decision, ANY failure here means the caller REJECTS THE WHOLE BOOKING (never a
 * partial success that silently drops the wallet claim) - callers must not create the appointment
 * on any `ok: false` result from this function.
 */
export async function verifyMobileBookingWalletClaim(
  input: VerifyMobileBookingWalletClaimInput,
): Promise<VerifyMobileBookingWalletClaimResult> {
  if (input.deadline <= input.issuedAt) return {ok: false, reason: "deadline_before_issued_at"};
  if (input.deadline - input.issuedAt > MOBILE_BOOKING_MAX_TTL_SECS) return {ok: false, reason: "window_too_long"};
  if (input.issuedAt > input.now + CLOCK_SKEW_ALLOWANCE_SECS) return {ok: false, reason: "issued_in_future"};
  if (input.now > input.deadline) return {ok: false, reason: "expired"};

  const domain = buildMobileBookingDomain(input.chainId, input.clinicCloneAddress);
  const message: MobileBookingMessage = {
    clinic: input.clinicCloneAddress,
    bookingHash: input.bookingHash,
    wallet: input.claimedWallet,
    issuedAt: BigInt(input.issuedAt),
    deadline: BigInt(input.deadline),
  };

  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain,
      types: MOBILE_BOOKING_TYPES,
      primaryType: MOBILE_BOOKING_PRIMARY_TYPE,
      message,
      signature: input.signature,
    });
  } catch {
    return {ok: false, reason: "signature_invalid"};
  }
  if (recovered.toLowerCase() !== input.claimedWallet.toLowerCase()) {
    return {ok: false, reason: "signature_invalid"};
  }

  return {ok: true, wallet: recovered.toLowerCase()};
}
