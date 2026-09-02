import {z} from "zod";

/**
 * `POST /api/pets/:id/export-tag-data` request body - WP4.10V item 3. `mask` is optional and
 * defaults to "nothing masked" (an ordinary, fully-disclosed export, the pre-WP4.10V behavior) -
 * this is the SHAPE gate only (non-empty strings, no duplicates-at-the-zod-level concern); the
 * semantic gate (every entry must actually be one of the active artifact's own disclosed leaf
 * keyPaths, and no duplicates) is `lib/tags/exportMask.ts`'s `validateExportMask`, which needs the
 * artifact loaded first and so cannot live in a static zod schema.
 */
export const exportMaskRequestSchema = z.object({
  mask: z.array(z.string().min(1)).optional(),
});
export type ExportMaskRequestInput = z.infer<typeof exportMaskRequestSchema>;
