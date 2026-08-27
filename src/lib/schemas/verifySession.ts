import {z} from "zod";
import {hexAddress, hex32, hex16Salt} from "@/lib/schemas/common";

export const startVerifySessionSchema = z.object({
  purpose: z.string().min(1),
  recordType: z.string().min(1),
  relayerAddress: hexAddress,
  appointmentId: z.string().optional(),
  clientId: z.string().optional(),
  petId: z.string().optional(),
});
export type StartVerifySessionInput = z.infer<typeof startVerifySessionSchema>;

export const grothProofSchema = z.object({
  a: z.tuple([z.string(), z.string()]),
  b: z.tuple([z.tuple([z.string(), z.string()]), z.tuple([z.string(), z.string()])]),
  c: z.tuple([z.string(), z.string()]),
  pubSignals: z.array(z.string()).length(7),
});

export const profileDisclosureEntrySchema = z.object({
  keyPath: z.string(),
  saltHex: hex16Salt,
  tag: z.number().int().min(0).max(5),
  value: z.string(),
  proof: z.array(z.string()),
});

export const profileDisclosureSchema = z.object({
  dogTagId: hex32,
  R: hex32,
  disclosures: z.array(profileDisclosureEntrySchema).min(1),
});

export const submitVerifyConsentSchema = z.object({
  exportToken: z.string().min(1),
  sessionId: z.string().optional(),
  proof: grothProofSchema,
  profileDisclosure: profileDisclosureSchema.optional(),
});
