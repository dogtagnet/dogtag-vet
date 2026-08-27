import {z} from "zod";
import {decimalString, isoDate} from "@/lib/schemas/common";

export const weightEntrySchema = z.object({
  unit: z.enum(["kg", "lb"]),
  value: decimalString,
  measuredOn: isoDate,
});

export const microchipSchema = z.object({
  code: z.string().trim().optional(),
  standard: z.enum(["ISO11784", "ISO11785", "FDX-B", "other"]).optional(),
  implantDate: isoDate.optional(),
  bodyLocation: z.string().trim().optional(),
});

export const createPetSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  species: z.string().trim().optional(),
  breed: z.string().trim().optional(),
  sex: z.enum(["male", "female", "unknown"]).optional(),
  dateOfBirth: isoDate.optional(),
  notes: z.string().optional(),
  microchip: microchipSchema.optional(),
  weightHistory: z.array(weightEntrySchema).optional(),
  ownerClientIds: z.array(z.string()).min(1, "At least one owner is required"),
});
export type CreatePetInput = z.infer<typeof createPetSchema>;

export const updatePetSchema = createPetSchema.partial();
export type UpdatePetInput = z.infer<typeof updatePetSchema>;
