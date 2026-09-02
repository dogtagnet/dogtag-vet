import {z} from "zod";
import {hex32, nonNegativeIntegerString} from "@/lib/schemas/common";
import {openedLeafSchema} from "@/lib/schemas/mintSession";

/**
 * `POST /i/:token/complete` request body - plans/wp4.9-tag-data-custody.md section 2.3, item 1's
 * own "registry-first" scope decision: this is the real, testable "malformed leaves" gate that
 * runs BEFORE the shared verifier (`lib/tags/verifier.ts`) ever sees the wire data, rather than
 * vendoring a full JSON-Schema-registry/ajv dependency this app has no other use for.
 *
 * `leaves`/`reservedLeafHashes` mirror `CustodialBindRequest`'s/`mobilePetClaimSchema`'s own
 * shape/caps exactly (the frozen 64-leaf tree, 3 reserved + up to 61 opened) - but unlike
 * `mobilePetClaimSchema`, both are REQUIRED here, never optional: submitting verification data is
 * the entire point of this endpoint, not an opt-in extra.
 */
export const importCompleteSchema = z
  .object({
    dogTagIdDec: z
      .string()
      .trim()
      .regex(/^\d+$/, "Must be a non-negative decimal integer string")
      .optional(),
    dogTagIdField: nonNegativeIntegerString.optional(),
    leaves: z.array(openedLeafSchema).max(61),
    reservedLeafHashes: z.array(hex32).length(3),
  })
  .superRefine((value, ctx) => {
    if (!value.dogTagIdDec && !value.dogTagIdField) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: "Requires dogTagIdDec and/or dogTagIdField."});
    }
  });
export type ImportCompleteInput = z.infer<typeof importCompleteSchema>;
