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
  /** WP4.14 V5 - which sibling wire shape this session ultimately serves. ABSENT (every session
   * created before this wave, and every tag-export session created since - `lib/tags/exportFlow.ts`
   * never sets this field) means `"tag"`, the identical "absence is the implicit tag case" rule
   * `specs/vet-public-api.yaml`'s `ArtifactExportResponse.artifactType` and `@dogtag/standard`'s
   * `RedactedTagArtifact` both already state. Only ever `"record"` when `recordId` (below) is also
   * set - `lib/records/exportFlow.ts` is the one place that happens. */
  artifactType?: "tag" | "record";
  /** WP4.14 V5 - set if and only if `artifactType === "record"`: the `RecordArtifact.recordId` this
   * session exports. A tag session has no analogous field (`root` below, together with `petId`, is
   * already sufficient to find the right `TagArtifact` - a pet has only one). `RecordArtifact.root`
   * is ALSO globally unique on its own (that model's own `unique: true`), so `root` alone would
   * resolve a record just as unambiguously - `recordId` is stored anyway so this ceremony looks a
   * record up the same way every other record route in this app already does (`findRecordArtifact`),
   * with `root` kept as a defensive equality check (`lib/records/exportFlow.ts`'s own store adapter)
   * rather than a second, independent lookup key. */
  recordId?: string;
  root: string; // lowercase - the TagArtifact (or RecordArtifact) root active at creation time
  exp: number; // unix seconds, createdAt + 600
  /**
   * WP4.10V item 3 - the keyPaths staff chose to mask, snapshotted at CREATION time exactly like
   * `root` above (never re-chosen at scan time). Absent (or `[]`) means an ordinary, fully-disclosed
   * export - the pre-WP4.10V default behavior. Validated against the active artifact's disclosed
   * leaf keyPaths at creation time (`lib/tags/exportMask.ts`'s `validateExportMask`) - by the time
   * `GET /e/:token` reads this back, it is already known-good, so `resolveAndConsumeExport` never
   * re-validates it, only recomputes each masked leaf's hash from its (still fully-known-to-this-
   * clinic) opening - never trusting a stored hash, exactly like every other check in this ceremony.
   */
  mask?: string[];
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
    artifactType: {type: String, enum: ["tag", "record"]},
    recordId: {type: String},
    root: {type: String, required: true},
    exp: {type: Number, required: true},
    mask: [String],
    usedAt: Number,
  },
  {timestamps: {createdAt: true, updatedAt: false}},
);

export const ArtifactExportSession =
  getOrCreateModel<ArtifactExportSessionDoc>("ArtifactExportSession", artifactExportSessionSchema);
