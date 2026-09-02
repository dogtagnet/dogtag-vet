import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";

/**
 * One `POST /api/pets/:id/export-tag-data` session - the one-time-token machinery for
 * plans/wp4.9-tag-data-custody.md section 2.2's export ceremony. Mirrors
 * `WalletRegistrationSession`'s "no /retry - a burned token is simply dead" shape: `GET /e/:token`
 * is itself the ONLY action (unlike wallet-registration/import's separate resolve+complete steps),
 * so this collection is even smaller than that one.
 *
 * `root` is snapshotted at CREATION time (the pet's active `TagArtifact.root` at the moment staff
 * clicked "share"), not re-read live at scan time - `lib/tags/exportFlow.ts`'s
 * `resolveAndConsumeExport` looks up the artifact by this EXACT `(petId, root)` pair, so a tag
 * replaced between session creation and the owner's scan makes this specific QR report `superseded`
 * rather than silently substituting whatever tag happens to be active by the time the phone gets to
 * it - the staff member sees (and the owner scans) a QR for the tag that was on screen when it was
 * generated, never a moving target.
 */
export interface ArtifactExportSessionDoc {
  token: string; // 32 lowercase hex, unique - specs/qr-formats.md's token grammar
  petId: string;
  root: string; // lowercase - the TagArtifact active for petId at creation time
  exp: number; // unix seconds, createdAt + 600
  /** Set atomically the instant this token is resolved - whether that resolution SUCCEEDED or was
   * refused (revoked/superseded) - never left open for a retry. See `resolveAndConsumeExport`'s own
   * doc comment for why a refusal still burns the token (mirrors `completeRegistration`'s
   * `signature_invalid` precedent: any check requiring a fresh per-attempt read, rather than one
   * already decidable from the token row alone, is one-shot by design). */
  usedAt?: number;
  createdAt: Date;
}

const artifactExportSessionSchema = new Schema<ArtifactExportSessionDoc>(
  {
    token: {type: String, required: true, unique: true},
    petId: {type: String, required: true, index: true},
    root: {type: String, required: true},
    exp: {type: Number, required: true},
    usedAt: Number,
  },
  {timestamps: {createdAt: true, updatedAt: false}},
);

export const ArtifactExportSession =
  getOrCreateModel<ArtifactExportSessionDoc>("ArtifactExportSession", artifactExportSessionSchema);
