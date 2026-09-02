import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";

/**
 * One import-ceremony session - the one-time-token machinery for
 * plans/wp4.9-tag-data-custody.md section 2.3's import ceremony. Mirrors
 * `WalletRegistrationSession`'s two-step resolve/complete shape (`GET /i/:token` non-consuming,
 * `POST /i/:token/complete` consuming) rather than `ArtifactExportSession`'s single-GET shape -
 * unlike export, the phone submits data BACK here, so there is a real "build the response on
 * device, then post it" step for the owner's app to go through in between.
 */
export interface ArtifactImportSessionDoc {
  token: string; // 32 lowercase hex, unique - specs/qr-formats.md's token grammar
  /** Absent means "create a new pet from verified data" - chosen by STAFF at session-creation
   * time, never by the scanning phone. */
  targetPetId?: string;
  clinicName: string; // snapshotted at creation
  cloneAddress: string; // this clinic's VetIssuer clone, lowercase, snapshotted at creation
  exp: number; // unix seconds, createdAt + 600
  /** Set atomically the instant this token is resolved by `POST /i/:token/complete` - on EVERY
   * outcome, success or refusal, never left open for a retry. See `lib/tags/importFlow.ts`'s
   * `completeImport` for the full rationale (mirrors `completeRegistration`'s `signature_invalid`
   * precedent). `GET /i/:token` never sets this - it is non-consuming. */
  usedAt?: number;
  createdAt: Date;
}

const artifactImportSessionSchema = new Schema<ArtifactImportSessionDoc>(
  {
    token: {type: String, required: true, unique: true},
    targetPetId: {type: String, index: true},
    clinicName: {type: String, required: true},
    cloneAddress: {type: String, required: true},
    exp: {type: Number, required: true},
    usedAt: Number,
  },
  {timestamps: {createdAt: true, updatedAt: false}},
);

export const ArtifactImportSession =
  getOrCreateModel<ArtifactImportSessionDoc>("ArtifactImportSession", artifactImportSessionSchema);
