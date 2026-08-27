import {z} from "zod";
import {hex16Salt, hex32, hexAddress, hexToken32, isoDate} from "@/lib/schemas/common";
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
  ownerIdentity: ownerIdentitySchema,
  microchip: microchipSchema.optional(),
  profile: mintProfileSchema,
  /** The connected operator wallet the staff member will sign `issueTag` with - the server
   * preflights whitelist status against THIS address (never `ClinicSettings.operatorWallet`,
   * which is display-continuity only), so it must be supplied fresh on every start/retry. */
  operatorAddress: hexAddress,
});
export type StartMintSessionInput = z.infer<typeof startMintSessionSchema>;

/** `OpenedLeaf` in `vet-public-api.yaml`. */
export const openedLeafSchema = z.object({
  keyPath: z.string().min(1),
  saltHex: hex16Salt,
  tag: z.number().int().min(0).max(5),
  value: z.string(),
});

/**
 * `CustodialBindRequest` in `vet-public-api.yaml`: `leaves` caps at 61 (the frozen consent tree's
 * 64-leaf capacity minus the 3 reserved owner-control leaves - `MAX_TOTAL_LEAVES` in
 * `@dogtag/standard`'s `profileBind.ts`), `reservedLeafHashes` is always exactly 3.
 */
export const custodialBindRequestSchema = z.object({
  token: hexToken32,
  root: hex32,
  leaves: z.array(openedLeafSchema).max(61),
  reservedLeafHashes: z.array(hex32).length(3),
});
export type CustodialBindRequestInput = z.infer<typeof custodialBindRequestSchema>;
