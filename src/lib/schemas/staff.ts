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
