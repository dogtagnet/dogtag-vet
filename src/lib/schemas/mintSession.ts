import {z} from "zod";
import {isoDate} from "@/lib/schemas/common";
import {microchipSchema, weightEntrySchema} from "@/lib/schemas/pet";

export const ownerIdentitySchema = z.object({
  countryOfIdentification: z.string().length(2).optional(),
  identification: z.string().trim().optional(),
  name: z.string().trim().optional(),
});

export const mintProfileSchema = z.object({
  species: z.string().trim().optional(),
  breedVbo: z.string().trim().optional(),
  breedLabel: z.string().trim().optional(),
  sex: z.enum(["male", "female", "unknown"]).optional(),
  neuterStatus: z.enum(["intact", "neutered", "spayed", "unknown"]).optional(),
  dateOfBirth: isoDate.optional(),
  weightHistory: z.array(weightEntrySchema).default([]),
});

/** Staff-side `/tags/issue` start-session input: pick/create client+pet, enter owner identity and
 * pet profile. See wp4-vet.md's DogTag issuance flow, step 1. */
export const startMintSessionSchema = z.object({
  clientId: z.string().min(1),
  petId: z.string().optional(),
  petName: z.string().trim().min(1),
  dogTagIdDec: z.string().regex(/^\d+$/).optional(),
  ownerIdentity: ownerIdentitySchema,
  microchip: microchipSchema.optional(),
  profile: mintProfileSchema,
});
export type StartMintSessionInput = z.infer<typeof startMintSessionSchema>;
