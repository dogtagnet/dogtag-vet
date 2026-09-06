import {z} from "zod";

/**
 * `POST /api/pets/:id/records/:recordId/export` (and its `.../preview` sibling) request body - plan
 * section 11.2 V5. `mask` is optional and defaults to "nothing masked" (an ordinary, fully-disclosed
 * export). This is the SHAPE gate only; the semantic gate (every entry must be one of the record's
 * own disclosed leaf keyPaths, none of the seven non-maskable ones, no duplicates) is
 * `lib/records/exportMask.ts`'s `validateRecordExportMask`, which needs the record loaded first.
 */
export const recordExportMaskRequestSchema = z.object({
  mask: z.array(z.string().min(1)).optional(),
});
export type RecordExportMaskRequestInput = z.infer<typeof recordExportMaskRequestSchema>;
