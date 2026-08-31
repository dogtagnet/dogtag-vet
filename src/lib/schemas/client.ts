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

export const updateClientSchema = createClientSchema.partial();
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
