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
      // A bare DNS domain (host, not a URL) - `issuerDomain` in the C3 attestation message and
      // `IssuerMeta.domain` in every wrapped credential envelope (protocol/specs/issuer-attestation.md).
      domain: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "Enter a bare domain, e.g. acmevet.com")
        .optional(),
      phone: z.string().trim().optional(),
      primaryColor: z.string().trim().optional(),
      address: z
        .object({
          line1: z.string().trim().optional(),
          line2: z.string().trim().optional(),
          city: z.string().trim().optional(),
          region: z.string().trim().optional(),
          postalCode: z.string().trim().optional(),
          country: z.string().trim().length(2).optional(),
        })
        .optional(),
      coordinates: z
        .object({
          lat: z.number().min(-90).max(90),
          lng: z.number().min(-180).max(180),
        })
        .optional(),
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
  // WP4.15 multi-owner (PLANNED) - see ClinicSettings.ts's own doc comment on this field.
  consentRelayerViaCloneEnabled: z.boolean().optional(),
});
export type ClinicSettingsInput = z.infer<typeof clinicSettingsInputSchema>;
