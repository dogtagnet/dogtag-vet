/**
 * The masked-record-export field-picker validation (plan section 11.2 V5) - the record sibling of
 * `lib/tags/exportMask.ts`'s `validateExportMask`, with ONE real difference: a record artifact DOES
 * have a non-maskable set (exactly seven keyPaths, `RECORD_NON_MASKABLE_KEY_PATHS` from
 * `@dogtag/standard` - by Kenneth's decision, the opposite finding from a tag's "none, by evidence").
 * Naming one of those seven in `mask` is rejected here, explicitly, with its own reason - the plan's
 * own non-negotiable, verbatim: "the non-maskable set ... is locked in the export UI AND enforced
 * server-side". Relying on `verifyRecordArtifact`'s own self-check alone (it WOULD also reject such a
 * payload - the non-maskable check runs before its Merkle fold) would only ever surface as a
 * confusing 500 `internal_error` at export time, not a clear 400 field error at request time - so
 * this explicit pre-check exists for the response quality, not merely as defense in depth.
 */
export type RecordExportMaskErrorReason = "unknown_keypath" | "duplicate" | "non_maskable";

export interface RecordExportMaskError {
  keyPath: string;
  reason: RecordExportMaskErrorReason;
}

/**
 * Validates `mask` against `artifactLeafKeyPaths` (the record's own disclosed leaves) and
 * `nonMaskable` (the seven-keyPath set snapshotted on the record at issuance time -
 * `RecordArtifactDoc.nonMaskable`, never a live re-read of the constant - see that field's own doc
 * comment for why). `[]` (or omitted) is always valid - an ordinary, fully-disclosed record export.
 */
export function validateRecordExportMask(
  mask: readonly string[],
  artifactLeafKeyPaths: readonly string[],
  nonMaskable: readonly string[],
): RecordExportMaskError[] {
  const known = new Set(artifactLeafKeyPaths);
  const locked = new Set(nonMaskable);
  const seen = new Set<string>();
  const errors: RecordExportMaskError[] = [];

  for (const keyPath of mask) {
    if (seen.has(keyPath)) {
      errors.push({keyPath, reason: "duplicate"});
      continue;
    }
    seen.add(keyPath);
    if (locked.has(keyPath)) {
      errors.push({keyPath, reason: "non_maskable"});
      continue;
    }
    if (!known.has(keyPath)) {
      errors.push({keyPath, reason: "unknown_keypath"});
    }
  }

  return errors;
}
