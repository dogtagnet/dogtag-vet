import {z} from "zod";
import {moneySchema} from "@/lib/schemas/common";

export const createServiceSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  description: z.string().optional(),
  durationMinutes: z.number().int().min(1),
  bufferBeforeMin: z.number().int().min(0).default(0),
  bufferAfterMin: z.number().int().min(0).default(0),
  price: moneySchema.optional(),
  active: z.boolean().default(true),
  bookableOnline: z.boolean().default(false),
});
export type CreateServiceInput = z.infer<typeof createServiceSchema>;

export const updateServiceSchema = createServiceSchema.partial();
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;
