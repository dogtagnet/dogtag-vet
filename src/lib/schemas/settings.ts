import {z} from "zod";
import {hexAddress, paymentChainKey} from "@/lib/schemas/common";

export const receivingAddressSchema = z.object({
  chainKey: paymentChainKey,
  address: hexAddress,
});

export const clinicSettingsInputSchema = z.object({
  entityAccount: hexAddress.optional(),
  cloneAddress: hexAddress.optional(),
  operatorWallet: hexAddress.optional(),
  receivingAddresses: z.array(receivingAddressSchema).optional(),
  businessProfile: z
    .object({
      name: z.string().trim().optional(),
      logoUrl: z.string().url().optional(),
      contactEmail: z.string().trim().email().optional(),
    })
    .optional(),
  rpcOverrides: z
    .object({
      roax: z.string().url().optional(),
      ethereum: z.string().url().optional(),
      base: z.string().url().optional(),
      sepolia: z.string().url().optional(),
      baseSepolia: z.string().url().optional(),
    })
    .optional(),
});
export type ClinicSettingsInput = z.infer<typeof clinicSettingsInputSchema>;
