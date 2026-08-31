import {z} from "zod";

/** WP4.3 A2: optional identification-document fields - only `name` stays required on a client.
 * `idDocNumber` is deliberately excluded from `buildClientSearchKey` (src/lib/models/Client.ts)
 * and from WP4.2's `clientHash` canonicalization (src/lib/registration/clientHash.ts) - see the
 * doc comments there and docs/clients.md's "Identification fields" section for why. */
export const idDocTypeSchema = z.enum(["passport", "national_id", "drivers_license", "other"]);

export const createClientSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().min(1).optional(),
  address: z.string().trim().optional(),
  notes: z.string().optional(),
  idDocType: idDocTypeSchema.optional(),
  idDocNumber: z.string().trim().min(1).optional(),
});
export type CreateClientInput = z.infer<typeof createClientSchema>;

/**
 * Round-2 fix: `idDocType`/`idDocNumber` could be SET but never CLEARED through the product - an
 * emptied form field serialized to `undefined`, which `JSON.stringify` drops from the request body
 * entirely, so the PATCH route's "key absent means untouched" contract left the old value in place
 * while the UI still reported success. These two fields are now **nullable**, mirroring the
 * tri-state `updateAppointmentSchema.clientId` already ships (docs/appointments.md's "PATCH
 * contract"): the key absent means untouched, `null` is an explicit clear, and a non-empty string
 * is the new value - `""` is still rejected (400), the same as before, so `null` is the only way to
 * clear either field.
 *
 * Scoped to only these two fields, not extended to email/phone/address/notes: those four feed
 * `buildClientSearchKey` (Client.ts) AND WP4.2's `clientHash` canonicalization
 * (`src/lib/registration/clientHash.ts`), which already-issued wallet-registration receipts were
 * signed over - making them clearable changes what a searchKey rebuild or a clientHash computation
 * sees, which is a materially different, riskier change than this fix. `idDocType`/`idDocNumber`
 * are the only optional client fields excluded from BOTH of those by design (see the doc comment on
 * `ClientDoc` in Client.ts), which is exactly what makes clearing them safe to ship on its own.
 */
export const updateClientSchema = createClientSchema.partial().extend({
  idDocType: idDocTypeSchema.nullable().optional(),
  idDocNumber: z.string().trim().min(1).nullable().optional(),
});
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
