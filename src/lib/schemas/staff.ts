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
    // self-service editing of one's own row for a SUBSET of these (WP4.13's firstName/lastName/
    // title/accreditationNumber, WP4.7C's walletAddress) also exists via the dedicated `/me/...`
    // routes below, each scoped to the session's own staffId - this schema stays the owner-only,
    // any-row surface for all of them.
    bookable: z.boolean().optional(),
    // `null` explicitly clears a previously-recorded value (`Staff.setStaffProfile`'s `$unset`
    // path) - distinct from omitting the field, which leaves whatever is stored untouched. WP4.13
    // fixes a pre-existing gap: `displayName` used to accept only a non-empty string, with no way
    // to clear it at all once set.
    displayName: z.string().trim().min(1).max(120).nullable().optional(),
    // WP4.13 (Kenneth issue 3) - the first/last name split, a title/qualification, and a
    // government accreditation number. See `Staff.ts`'s own doc comments for the tier order and
    // the internal-only rule on accreditationNumber.
    firstName: z.string().trim().min(1).max(120).nullable().optional(),
    lastName: z.string().trim().min(1).max(120).nullable().optional(),
    title: z.string().trim().min(1).max(40).nullable().optional(),
    accreditationNumber: z.string().trim().min(1).max(64).nullable().optional(),
    walletAddress: lowercaseHexAddress.nullable().optional(),
  })
  .refine(
    (v) =>
      v.role !== undefined ||
      v.disabled !== undefined ||
      v.bookable !== undefined ||
      v.displayName !== undefined ||
      v.firstName !== undefined ||
      v.lastName !== undefined ||
      v.title !== undefined ||
      v.accreditationNumber !== undefined ||
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

/**
 * WP4.13 item 2 - the self-service counterpart to `updateStaffSchema` for a vet/owner editing
 * THEIR OWN name/title/accreditation (Kenneth issue 3: "split the name of the vet from display
 * name to first name, last name... qualifications / title field... government accreditation
 * number"), modelled directly on `selfWalletSchema` above: `.strict()` so an unexpected key (a
 * `role`, `bookable`, or `walletAddress` a client should never be able to send here) is rejected
 * outright with a 400, and every field independently optional-but-nullable so a PATCH may touch
 * any subset of the four and `null` clears one (`setStaffProfile`'s `$unset` contract) - unlike
 * `selfWalletSchema`'s single always-required field, this route can update several fields at once,
 * so the "at least one" refine (not "exactly one") is the right shape here, matching
 * `updateStaffSchema`'s own refine style.
 */
export const selfProfileSchema = z
  .object({
    firstName: z.string().trim().min(1).max(120).nullable().optional(),
    lastName: z.string().trim().min(1).max(120).nullable().optional(),
    title: z.string().trim().min(1).max(40).nullable().optional(),
    accreditationNumber: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .strict()
  .refine(
    (v) => v.firstName !== undefined || v.lastName !== undefined || v.title !== undefined || v.accreditationNumber !== undefined,
    {message: "At least one field is required."},
  );
export type SelfProfileInput = z.infer<typeof selfProfileSchema>;
