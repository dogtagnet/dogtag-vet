import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomUUID} from "node:crypto";

/**
 * Plan section 11.2 V6 - "Records mode" on `/verify`: a QR/token ceremony STRUCTURALLY like `/w`'s
 * or `/i`'s (non-consuming `GET` resolve, consuming `POST .../complete`) rather than `/e`'s one-shot
 * `GET`-only shape, because - unlike an export, where there is genuinely nothing for the phone to
 * submit back - here the phone DOES submit something (a masked `RecordArtifact` JSON) and needs to
 * see the clinic's name/purpose before deciding to. Structurally NOTHING like `VerifySession.ts`
 * (the ZK-consent flow): no Groth16 proof, no relayer wallet, no on-chain write at all - verifying a
 * presented record is a pure READ-and-check against already-anchored chain state
 * (`lib/records/verifier.ts`), never a new consent event staff submits.
 *
 * This flow has no existing protocol-spec coverage yet (checked: `specs/qr-formats.md` and
 * `specs/vet-public-api.yaml` document `/e`/`/w`/`/x`/`/i` and the ZK `VerifySession` shape, nothing
 * for "present a record for verification") - plan section 11.2 V7 formalizes this as an additive
 * spec change on the protocol branch once this app-side design has proven itself; this model and its
 * routes are the reference implementation V7 mirrors from, not the other way around.
 */
export type RecordVerifySessionStatus = "pending" | "presented";

/** Mirrors `lib/records/verifier.ts`'s `RecordVerifyStage` union structurally (a plain, storable
 * projection of it - never re-exported from that module directly, so this model stays free of any
 * dependency on the verification pipeline's own pure-logic types, the same "flow modules stay
 * mongoose-free, adapters translate" convention every other ceremony in this app already follows). */
export interface RecordVerifyStoredResult {
  stage: "crypto_failed" | "chain_unreadable" | "not_anchored" | "wrong_chain" | "verified";
  reason?: string;
  issuerClone?: string;
  recordType?: string;
  /** Grade round 1 D1: widened from valid|expired|revoked. `hidden` - the presented artifact
   * withheld validFrom and/or validUntil (both are ordinary maskable leaves), so this deployment
   * has no basis to compute a verdict and says so rather than guessing `valid`. `not_yet_valid` -
   * validFrom was disclosed and is still in the future, never collapsed into `expired`. See
   * `lib/records/validity.ts`'s `computeRecordValidity`, the single shared decision procedure. */
  validity?: "valid" | "expired" | "revoked" | "hidden" | "not_yet_valid";
  disclosedKeyPaths?: string[];
  /** Plan section 11.2 V6's own explicit ask: "disclosed fields, hidden count". Set unconditionally
   * alongside `disclosedKeyPaths` regardless of `stage` (same reasoning: even a `crypto_failed` or
   * `not_anchored` presentment still structurally names how many leaves it withheld), computed as
   * `obfuscatedLeafHashes.length` directly off the presented artifact - never a diff against the
   * record type's full schema field set, which would fabricate a number for fields the issuer simply
   * never populated. Zero new trust: `recordArtifactWireSchema` has already shape-validated
   * `obfuscatedLeafHashes` before this is read. */
  hiddenCount?: number;
}

export interface RecordVerifySessionDoc {
  sessionId: string;
  /** 32 lowercase hex, unique - the same token grammar every other QR ceremony in this app uses
   * (`specs/qr-formats.md`). */
  token: string;
  /** Fixed literal, never staff-chosen (unlike the ZK flow's free-text `purpose`) - this ceremony
   * has exactly one purpose. */
  purpose: "RECORD_PRESENT";
  exp: number; // unix seconds, createdAt + 600
  status: RecordVerifySessionStatus;
  result?: RecordVerifyStoredResult;
  presentedAt?: number;
  createdAt: Date;
}

const recordVerifyStoredResultSchema = new Schema<RecordVerifyStoredResult>(
  {
    stage: {type: String, required: true, enum: ["crypto_failed", "chain_unreadable", "not_anchored", "wrong_chain", "verified"]},
    reason: String,
    issuerClone: String,
    recordType: String,
    validity: {type: String, enum: ["valid", "expired", "revoked", "hidden", "not_yet_valid"]},
    disclosedKeyPaths: [String],
    hiddenCount: Number,
  },
  {_id: false},
);

const recordVerifySessionSchema = new Schema<RecordVerifySessionDoc>(
  {
    sessionId: {type: String, required: true, unique: true, default: () => randomUUID()},
    token: {type: String, required: true, unique: true},
    purpose: {type: String, required: true, enum: ["RECORD_PRESENT"], default: "RECORD_PRESENT"},
    exp: {type: Number, required: true},
    status: {type: String, required: true, enum: ["pending", "presented"], default: "pending"},
    result: recordVerifyStoredResultSchema,
    presentedAt: Number,
  },
  {timestamps: {createdAt: true, updatedAt: false}},
);

export const RecordVerifySession = getOrCreateModel<RecordVerifySessionDoc>("RecordVerifySession", recordVerifySessionSchema);
