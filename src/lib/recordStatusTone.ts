import type {RecordArtifactStatus} from "@/lib/models/RecordArtifact";
import type {RecordValidity} from "@/lib/records/validity";
import type {StatusTone} from "@/components/ui/StatusBadge";

/**
 * Single source of truth mapping a `RecordArtifact`'s own lifecycle `status` onto the shared
 * status-tone palette (design-system.md) - the record sibling of `tagStatusTone.ts`'s
 * `dogTagStatusTone`/`mintSessionStatusTone`, collapsed into one map since a record has no separate
 * "in-flight session vs. durable row" split (`RecordArtifact.ts`'s own header comment: one row is
 * the whole lifecycle, `draft` through `active`/`revoked`/`error`).
 */
export const recordStatusTone: Record<RecordArtifactStatus, StatusTone> = {
  draft: "neutral",
  issuing: "info",
  active: "ok",
  revoked: "danger",
  error: "danger",
};

export const recordStatusLabel: Record<RecordArtifactStatus, string> = {
  draft: "Draft",
  issuing: "Issuing",
  active: "Active",
  revoked: "Revoked",
  error: "Error",
};

/** The Records tab's own "validity" column (plan section 11.2 V4) - distinct from `status` above:
 * `status` is this row's own on-chain lifecycle state; `validity` is the CLINICAL Valid/Expired
 * fact `lib/records/validity.ts`'s `computeRecordValidity` derives from `validUntil`, with
 * revocation folded in so the two columns never visibly contradict each other (a revoked record
 * never shows "Valid" just because today happens to still be inside its date window). */
export const recordValidityTone: Record<RecordValidity, StatusTone> = {
  valid: "ok",
  expired: "warn",
  revoked: "danger",
  pending: "neutral",
  hidden: "warn",
  not_yet_valid: "warn",
};

export const recordValidityLabel: Record<RecordValidity, string> = {
  valid: "Valid",
  expired: "Expired",
  revoked: "Revoked",
  pending: "Not yet issued",
  hidden: "Validity hidden",
  not_yet_valid: "Not yet valid",
};
