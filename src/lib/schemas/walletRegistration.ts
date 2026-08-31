import {z} from "zod";
import {hexAddress, hexSignature65} from "@/lib/schemas/common";

/** `POST /w/:token/complete` body - plans/wp4.2-client-wallet-registration.md, dogtag-vet section
 * 4: `{wallet, signature}`. */
export const completeWalletRegistrationSchema = z.object({
  wallet: hexAddress,
  signature: hexSignature65,
});
export type CompleteWalletRegistrationInput = z.infer<typeof completeWalletRegistrationSchema>;

/** `PATCH /api/clients/:id/wallets/:address` body - staff label edit. An empty string clears the
 * label (stored as unset), matching how other optional text fields in this app treat blank input. */
export const walletLabelSchema = z.object({
  label: z.string().trim().max(200).optional(),
});
export type WalletLabelInput = z.infer<typeof walletLabelSchema>;
