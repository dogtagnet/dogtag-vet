import {z} from "zod";
import {decimalString, moneySchema, paymentChainKey, paymentToken, unixSeconds} from "@/lib/schemas/common";

export const lineItemSchema = z.object({
  description: z.string().trim().min(1),
  qty: z.number().min(0),
  unitAmount: decimalString,
  amount: decimalString,
});

export const createPaymentSchema = z.object({
  clientId: z.string().optional(),
  petId: z.string().optional(),
  appointmentId: z.string().optional(),
  lineItems: z.array(lineItemSchema).min(1, "At least one line item is required"),
  currency: z.string().length(3),
  tax: z
    .object({
      label: z.string(),
      rate: decimalString,
      amount: decimalString,
    })
    .optional(),
  dueAt: unixSeconds.optional(),
  acceptedRails: z.array(z.object({chainKey: paymentChainKey, token: paymentToken})).default([]),
  notes: z.string().optional(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const markPaidSchema = z.object({
  note: z.string().optional(),
});

export {moneySchema};
