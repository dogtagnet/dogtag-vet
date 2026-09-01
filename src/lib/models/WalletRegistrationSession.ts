import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";

/**
 * One `POST /api/clients/:id/wallet-registrations` session - the one-time-token machinery for
 * plans/wp4.2-client-wallet-registration.md's wallet registration flow. Unlike mint (which splits
 * `BindToken`/`MintSession` across two collections because a `MintSession` can outlive several
 * successive bind tokens via `/retry`), a registration session and its one-time token are 1:1 -
 * there is no retry endpoint (a burned token, whether by success or a bad signature, is simply
 * dead; the staff member starts a fresh session) - so this repo folds both into one document
 * rather than adding a second collection with no behavioral payoff.
 *
 * `clinic`/`chainId`/`clinicName`/`maskedClientName` are all snapshotted at creation time (never
 * re-read live from `ClinicSettings`/`Client` on resolve) - see `lib/registration/flow.ts`'s doc
 * comment on `RegistrationSessionRow` for why.
 */
export interface WalletRegistrationSessionDoc {
  token: string; // 32 lowercase hex, unique - specs/qr-formats.md
  registrationId: string; // uuid v4, unique
  clientId: string;
  clinic: string; // clone address, lowercase 0x hex, snapshotted at creation
  chainId: number; // snapshotted at creation
  clinicName: string; // snapshotted at creation
  maskedClientName: string; // snapshotted at creation - never the raw name
  clientHash: string; // 0x hex32
  issuedAt: number; // unix seconds
  blockNumber: number;
  deadline: number; // unix seconds
  consumed: boolean;
  /** Set atomically alongside `consumed: true` - the staff status poll keeps answering
   * `registered`/`failed` for `STATUS_GRACE_PERIOD_SECS` measured from this timestamp
   * (`lib/registration/flow.ts`), then reports the session as gone. */
  consumedAt?: number;
  /** WP4.5 track3-sig fix 3 - see `lib/registration/flow.ts`'s `RegistrationSessionRow.outcome`
   * doc comment for the full rationale; this is that same field, persisted. */
  outcome?: "registered" | "signature_invalid";
  createdAt: Date;
}

const walletRegistrationSessionSchema = new Schema<WalletRegistrationSessionDoc>(
  {
    token: {type: String, required: true, unique: true},
    registrationId: {type: String, required: true, unique: true},
    clientId: {type: String, required: true, index: true},
    clinic: {type: String, required: true},
    chainId: {type: Number, required: true},
    clinicName: {type: String, required: true},
    maskedClientName: {type: String, required: true},
    clientHash: {type: String, required: true},
    issuedAt: {type: Number, required: true},
    blockNumber: {type: Number, required: true},
    deadline: {type: Number, required: true},
    consumed: {type: Boolean, required: true, default: false},
    consumedAt: Number,
    outcome: {type: String, enum: ["registered", "signature_invalid"]},
  },
  {timestamps: {createdAt: true, updatedAt: false}},
);

export const WalletRegistrationSession =
  getOrCreateModel<WalletRegistrationSessionDoc>("WalletRegistrationSession", walletRegistrationSessionSchema);
