import {z} from "zod";
import {decimalString, moneySchema, paymentChainKey, paymentToken, unixSeconds} from "@/lib/schemas/common";

export const lineItemSchema = z.object({
  description: z.string().trim().min(1),
  qty: z.number().min(0),
  unitAmount: decimalString,
  amount: decimalString,
});

/** What the create-payment request actually needs per line item - `amount` is deliberately absent:
 * it is always recomputed server-side from `unitAmount * qty` (`src/lib/payments/money.ts`), never
 * trusted from the client. */
export const createLineItemSchema = z.object({
  description: z.string().trim().min(1),
  qty: z.number().min(0),
  unitAmount: decimalString,
});

export const createPaymentSchema = z.object({
  clientId: z.string().optional(),
  petId: z.string().optional(),
  appointmentId: z.string().optional(),
  lineItems: z.array(createLineItemSchema).min(1, "At least one line item is required"),
  currency: z.string().length(3),
  tax: z
    .object({
      label: z.string(),
      rate: decimalString,
    })
    .optional(),
  dueAt: unixSeconds.optional(),
  acceptedRails: z
    .array(
      z.object({
        chainKey: paymentChainKey,
        token: paymentToken,
        /** A staff-entered rate (fiat per token) to use ONLY if the live CoinGecko quote (and its
         * 10-minute cache) both fail - the manual-rate fallback UI in wp4-vet.md's payments
         * section. Omitted rails always attempt the live/cached quote first. */
        manualRate: decimalString.optional(),
      }),
    )
    .default([]),
  notes: z.string().optional(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const markPaidSchema = z.object({
  note: z.string().trim().min(1, "A note is required for a manual mark-paid"),
});

export const emailPaymentSchema = z.object({
  email: z.string().trim().email(),
});

export {moneySchema};
