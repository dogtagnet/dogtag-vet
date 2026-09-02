/**
 * The masked-export field-picker validation (WP4.10V item 3, plan section 2's format). Pure, no
 * I/O - takes the ACTIVE artifact's own disclosed leaf keyPaths (the ONLY thing a mask can ever
 * name) and the staff-picked `mask` array, and reports every entry that cannot be honored.
 *
 * NON-MASKABLE keyPaths: NONE (WP4.10S's own evidence-based ruling - `specs/leaf-commitment.md`
 * section 15, mirrored in `@dogtag/standard`'s `redactedArtifact.ts` file header). There is
 * therefore no "non_maskable" rejection reason in this validator, deliberately - not an omission.
 * The reserved owner-control triple (`owner.address`/`owner.consentKey`/`owner.secret`) is never a
 * candidate in the first place: it never appears in `artifact.leaves` at all (only as opaque
 * `reservedLeafHashes`, with no keyPath recorded), so naming one in `mask` already falls out as
 * `unknown_keypath` below - no separate reserved-namespace check is needed to reject it.
 */
export type ExportMaskErrorReason = "unknown_keypath" | "duplicate";

export interface ExportMaskError {
  keyPath: string;
  reason: ExportMaskErrorReason;
}

/**
 * Validates `mask` against `artifactLeafKeyPaths` (the active artifact's OWN disclosed leaves,
 * `TagArtifactDoc.leaves.map(l => l.keyPath)`). Returns `[]` when every entry is valid - a caller
 * MAY still pass an empty `mask` (or omit it) for an ordinary, fully-disclosed export; this
 * function only ever rejects entries that are actually present, never requires at least one.
 *
 * `unknown_keypath`: not among the artifact's own leaves - either a typo, a keyPath belonging to
 * some OTHER artifact/pet, or (per this file's own header) a reserved owner-control name that was
 * never a leaf keyPath to begin with.
 * `duplicate`: the SAME keyPath named more than once - harmless to the underlying crypto (masking
 * a leaf twice is idempotent) but rejected here as a wire-hygiene field error, the same spirit
 * `verifyRedactedArtifact`'s own duplicate-disclosed-keyPath check applies to the opposite array.
 */
export function validateExportMask(mask: readonly string[], artifactLeafKeyPaths: readonly string[]): ExportMaskError[] {
  const known = new Set(artifactLeafKeyPaths);
  const seen = new Set<string>();
  const errors: ExportMaskError[] = [];

  for (const keyPath of mask) {
    if (seen.has(keyPath)) {
      errors.push({keyPath, reason: "duplicate"});
      continue;
    }
    seen.add(keyPath);
    if (!known.has(keyPath)) {
      errors.push({keyPath, reason: "unknown_keypath"});
    }
  }

  return errors;
}
