import {z} from "zod";
import {hex32, nonNegativeIntegerString} from "@/lib/schemas/common";
import {openedLeafSchema} from "@/lib/schemas/mintSession";

/** Deep-equal over two `OpenedLeaf`-shaped arrays, field by field (never a raw `JSON.stringify`
 * compare, which would be sensitive to incidental key-order differences within each leaf object) -
 * used only to catch a body that sends BOTH `leaves` and `disclosed` with DIFFERING content (see
 * `importCompleteSchema`'s own doc comment on why both names can appear at all). */
function sameLeafArray(a: readonly z.infer<typeof openedLeafSchema>[], b: readonly z.infer<typeof openedLeafSchema>[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((leaf, i) => {
    const other = b[i]!;
    return leaf.keyPath === other.keyPath && leaf.saltHex === other.saltHex && leaf.tag === other.tag && leaf.value === other.value;
  });
}

const openedLeafArraySchema = z.array(openedLeafSchema).max(61);

/**
 * `POST /i/:token/complete` request body - plans/wp4.9-tag-data-custody.md section 2.3, item 1's
 * own "registry-first" scope decision: this is the real, testable "malformed leaves" gate that
 * runs BEFORE the shared verifier (`lib/tags/verifier.ts`) ever sees the wire data, rather than
 * vendoring a full JSON-Schema-registry/ajv dependency this app has no other use for.
 *
 * `leaves`/`reservedLeafHashes` mirror `CustodialBindRequest`'s/`mobilePetClaimSchema`'s own
 * shape/caps exactly (the frozen 64-leaf tree, 3 reserved + up to 61 opened).
 *
 * WP4.10V item 6 TRANSITION (orchestrator ruling, P2 finding - corrected from this file's original
 * "just rename to disclosed" approach, which would have broken WP4.9M's already-shipped
 * `ArtifactShareEngine`, the real phone-side sender that encodes this exact request body with a
 * non-optional `leaves` key today): `leaves` and `disclosed` are BOTH accepted, describing the
 * SAME thing (the disclosed openings) under two names - `leaves` is what every sender before
 * WP4.10M (the not-yet-built masked-aware phone client) sends; `disclosed` is the canonical
 * `RedactedTagArtifact` field name (plan section 2) WP4.10M will send once it ships. At least one
 * is required; if a body sends BOTH, their content must agree exactly (`sameLeafArray` above) -
 * two different claims about "what was disclosed" in the same request is rejected, never silently
 * resolved by picking one. Normalized to a single `leaves` field downstream (the `.transform`
 * below) so every consumer of this schema's output keeps reading one name, regardless of which the
 * wire actually used.
 *
 * `obfuscatedLeafHashes` and `schemaId` are new, both OPTIONAL - a claim with neither is exactly
 * the pre-WP4.10V shape, byte-for-byte (an ordinary, fully-disclosed import, including WP4.9M's
 * own `leaves`-only, no-`obfuscatedLeafHashes` shape, which this schema still accepts unchanged).
 * `leaves.max(61)` ALONE would let 61 disclosed plus 61 obfuscated through this gate at once (122,
 * far past the frozen 64-leaf tree's capacity) - the joint `superRefine` below catches that as a
 * field error here, rather than leaving it to `verifyRedactedArtifact`'s own cap check further
 * downstream to reject less specifically.
 */
export const importCompleteSchema = z
  .object({
    dogTagIdDec: z
      .string()
      .trim()
      .regex(/^\d+$/, "Must be a non-negative decimal integer string")
      .optional(),
    dogTagIdField: nonNegativeIntegerString.optional(),
    leaves: openedLeafArraySchema.optional(),
    disclosed: openedLeafArraySchema.optional(),
    obfuscatedLeafHashes: z.array(hex32).max(61).optional(),
    reservedLeafHashes: z.array(hex32).length(3),
    schemaId: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.dogTagIdDec && !value.dogTagIdField) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: "Requires dogTagIdDec and/or dogTagIdField."});
    }
    if (!value.leaves && !value.disclosed) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: "Requires leaves and/or disclosed.", path: ["leaves"]});
    }
    if (value.leaves && value.disclosed && !sameLeafArray(value.leaves, value.disclosed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "leaves and disclosed are both present but describe different openings - send only one.",
        path: ["disclosed"],
      });
    }
    const effectiveLeaves = value.leaves ?? value.disclosed ?? [];
    const totalLeaves = value.reservedLeafHashes.length + effectiveLeaves.length + (value.obfuscatedLeafHashes?.length ?? 0);
    if (totalLeaves > 64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Total leaf count (reserved + leaves + obfuscatedLeafHashes) is ${totalLeaves}, exceeding the 64-leaf cap.`,
        path: ["obfuscatedLeafHashes"],
      });
    }
  })
  .transform(({disclosed, ...value}) => ({
    ...value,
    // Normalized to ONE canonical field for every downstream consumer - whichever the wire sent
    // (or their agreed-upon content, if both were sent), never `disclosed` surviving separately.
    leaves: value.leaves ?? disclosed ?? [],
  }));
export type ImportCompleteInput = z.infer<typeof importCompleteSchema>;
