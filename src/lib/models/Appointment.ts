import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomUUID} from "node:crypto";

export type AppointmentStatus =
  | "scheduled"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

export type AppointmentSource = "staff" | "public_booking" | "mobile";

export type TagResolution = "local" | "issued_here_unlinked" | "external" | "unknown" | "none";

/**
 * WP4.4 provenance: what the mobile app CLAIMED about who's booking and which pet they hold a tag
 * for, and how much of it the server actually verified - plans/wp4.4-mobile-booking-protocol.md
 * section 1 (normative shape) plus section 3's tier-resolution fields, which the spec's abbreviated
 * wire example doesn't spell out individually but whose OWN behavior requirements necessitate
 * persisting somewhere: `needsReview`/`candidatePetId` (tier 1's ownership-mismatch hijack guard),
 * `issuerValid` (tier 4's on-chain validity check against the issuer clone), `verificationError`
 * (distinguishing "genuinely no such tag" from "the chain could not be read" - both fold to the
 * SAME locked `tagResolution: "unknown"`, but the provenance box shows different copy for each),
 * and `bookingHash` (the persisted anchor `POST /v1/booking/book` dedupes signed claims against -
 * see the unique index below). Only ever set for `source: "mobile"`; absent on every other source.
 */
export interface BookingIdentity {
  /** Lowercased 0x address - present whenever the wire carried a `mobile.wallet` block, regardless
   * of whether it verified (an INVALID claim rejects the whole booking per Q2, so in practice this
   * is only ever persisted alongside `walletVerified: true` - but the field itself does not encode
   * that on its own, `walletVerified` does). */
  walletAddress?: string;
  walletVerified: boolean;
  /** keccak256 over the canonical booking content (`lib/booking/bookingHash.ts`) - the signed
   * claim's replay-protection anchor. Present only when a wallet claim was verified AND this
   * appointment is still in a non-terminal status - see `releasedBookingHash` below. */
  bookingHash?: string;
  /** Review finding 1: where `bookingHash` moves when this appointment goes terminal
   * (`setAppointmentTerminalStatus`'s `$rename` - cancelled/no_show release the signed claim
   * along with the capacity buckets, so the same configuration can be legitimately re-booked).
   * Kept rather than deleted so the provenance trail of WHICH signed claim booked this
   * appointment survives its cancellation. Never carries a unique index - two attempts of the
   * same claim can both end up cancelled over time, and that is fine. */
  releasedBookingHash?: string;
  dogTagIdDec?: string;
  tagResolution: TagResolution;
  /** Lowercased 0x address - the clone that issued the claimed tag. Present for
   * `"issued_here_unlinked"` (equals this clinic's own clone) and `"external"` (some other clone). */
  issuerClone?: string;
  /** Tier 1 only: a local pet matched the claimed dogTagId, but the client this booking resolved
   * to is NOT among that pet's owners - the pet is deliberately NOT linked (see
   * `lib/booking/mobileReconcile.ts`'s doc comment), and this flags it for staff review. */
  needsReview?: boolean;
  /** Tier 1 only, alongside `needsReview` - the pet the claim named, for staff to look at. */
  candidatePetId?: string;
  /** Tier 4 ("external") only - `VetIssuer.isValid(root)` against the issuer clone. */
  issuerValid?: boolean;
  /** Tier 4 ("external") only - did the wire carry both `leaves` and `reservedLeafHashes`? */
  dataVerificationAttempted?: boolean;
  /** Tier 4 ("external") only - Q3's full gate: did the sent leaves recompute (via
   * `verifyLeafCommitment`) to the on-chain root? Only then was a provisional pet imported. */
  dataVerified?: boolean;
  /** `true` when a chain read failed transiently while resolving this claim - `tagResolution` is
   * still the locked `"unknown"` either way, but this tells the provenance box "couldn't verify,
   * try again" apart from "no such tag exists". Never set alongside any tier other than
   * `"unknown"`. */
  verificationError?: boolean;
  /** Review finding 4: set when the post-insert side effects (Q3's provisional pet import/reuse,
   * Q1's wallet auto-attach - `lib/booking/postBooking.ts`) failed AFTER this appointment was
   * durably created. The booking itself succeeded and the client received their confirmation and
   * manage token; this flags the FOLLOW-UP records (pet link, client-pet association, wallet
   * entry) as possibly missing, surfaced as a review banner in the provenance box. */
  postBookingIncomplete?: boolean;
}

export interface AppointmentDoc {
  appointmentId: string;
  clientId?: string;
  /** WP4.3 A1: replaces the never-set `petId?` - one client, N pets. Always an array on any
   * document created after this change (mongoose `default: []`); a document from before it exists
   * only in history no environment actually carries (verified at design time - see
   * plans/wp4.3-appointment-tagging-client-id.md's Facts section), but `default` only fires at
   * CREATION time regardless, so every read site still defensively coalesces with `?? []` rather
   * than trusting the type alone (the same class of gap `ClientDoc.wallets` has - see
   * `api/clients/[id]/route.ts`'s doc comment on it). */
  petIds: string[];
  serviceId?: string;
  staffName?: string;
  startAt: number; // unix seconds
  endAt: number; // unix seconds
  status: AppointmentStatus;
  notes?: string;
  source: AppointmentSource;
  clientName: string;
  petName: string;
  cancelToken?: string;
  /** WP4.4 - only ever set for `source: "mobile"`. See `BookingIdentity`'s own doc comment. */
  bookingIdentity?: BookingIdentity;
  createdAt: Date;
  updatedAt: Date;
}

const bookingIdentitySchema = new Schema<BookingIdentity>(
  {
    walletAddress: String,
    walletVerified: {type: Boolean, required: true},
    bookingHash: String,
    releasedBookingHash: String,
    dogTagIdDec: String,
    tagResolution: {type: String, enum: ["local", "issued_here_unlinked", "external", "unknown", "none"], required: true},
    issuerClone: String,
    needsReview: Boolean,
    candidatePetId: String,
    issuerValid: Boolean,
    dataVerificationAttempted: Boolean,
    dataVerified: Boolean,
    verificationError: Boolean,
    postBookingIncomplete: Boolean,
  },
  {_id: false},
);

const appointmentSchema = new Schema<AppointmentDoc>(
  {
    appointmentId: {type: String, required: true, unique: true, default: () => randomUUID()},
    clientId: {type: String, index: true},
    petIds: {type: [String], default: [], index: true},
    serviceId: {type: String, index: true},
    staffName: String,
    startAt: {type: Number, required: true, index: true},
    endAt: {type: Number, required: true},
    status: {
      type: String,
      enum: ["scheduled", "confirmed", "in_progress", "completed", "cancelled", "no_show"],
      required: true,
      default: "scheduled",
      index: true,
    },
    notes: String,
    source: {type: String, enum: ["staff", "public_booking", "mobile"], required: true},
    clientName: {type: String, required: true},
    petName: {type: String, required: true},
    cancelToken: {type: String, index: true, sparse: true, unique: true},
    bookingIdentity: bookingIdentitySchema,
  },
  {timestamps: true},
);

// Replay-protection backstop for a signed wallet claim's bookingHash (the booking route's own
// pre-check is the primary enforcement - see its doc comment; this index exists so a genuine race
// between two concurrent replays of the identical signed claim can never both succeed, the same
// belt-and-suspenders style `cancelToken`'s own unique index above already uses). A
// `partialFilterExpression` (not `sparse`) so the invariant only ever applies to documents that
// actually carry a `bookingIdentity.bookingHash` - `sparse` alone would not protect against two
// documents that both explicitly stored `null` there, which `partialFilterExpression`'s `$exists`
// does.
appointmentSchema.index(
  {"bookingIdentity.bookingHash": 1},
  {unique: true, partialFilterExpression: {"bookingIdentity.bookingHash": {$exists: true}}},
);

export const Appointment =
  getOrCreateModel<AppointmentDoc>("Appointment", appointmentSchema);
