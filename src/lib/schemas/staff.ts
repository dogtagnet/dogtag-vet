import {z} from "zod";

export const inviteStaffSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["owner", "staff", "vet"]),
});
export type InviteStaffInput = z.infer<typeof inviteStaffSchema>;

export const updateStaffSchema = z
  .object({
    role: z.enum(["owner", "staff", "vet"]).optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.disabled !== undefined, {message: "role or disabled is required."});
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;
