import {z} from "zod";
import {lowercaseHexAddress} from "@/lib/schemas/common";

export const inviteStaffSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["owner", "staff", "vet"]),
});
export type InviteStaffInput = z.infer<typeof inviteStaffSchema>;

export const updateStaffSchema = z
  .object({
    role: z.enum(["owner", "staff", "vet"]).optional(),
    disabled: z.boolean().optional(),
    // WP4.7 A3 - practitioner-profile fields (D2/D4). Owner-only, same route as role/disabled;
    // self-service editing of one's own row is explicitly out of scope for this WP.
    bookable: z.boolean().optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    // `null` explicitly clears a previously-recorded wallet (`Staff.setStaffProfile`'s `$unset`
    // path) - distinct from omitting the field, which leaves whatever is stored untouched.
    walletAddress: lowercaseHexAddress.nullable().optional(),
  })
  .refine(
    (v) =>
      v.role !== undefined ||
      v.disabled !== undefined ||
      v.bookable !== undefined ||
      v.displayName !== undefined ||
      v.walletAddress !== undefined,
    {message: "At least one field is required."},
  );
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;

/**
 * WP4.7C item 2 - the self-service counterpart to `updateStaffSchema` above: a vet/owner setting
 * or clearing THEIR OWN `walletAddress` (K2: "the vet can register their own... address"). Always
 * exactly one field, always required (never "leave unchanged" - this route only ever does one
 * thing), `.strict()` so an unexpected key (e.g. a `role` a client should never be able to send
 * here) is rejected outright with a 400 rather than silently dropped - there is no key in this
 * schema that could ever change who is vet/owner/staff, or touch any row but the caller's own
 * (staffId comes from the session, never from the body - see the route handler).
 */
export const selfWalletSchema = z
  .object({
    walletAddress: lowercaseHexAddress.nullable(),
  })
  .strict();
export type SelfWalletInput = z.infer<typeof selfWalletSchema>;
