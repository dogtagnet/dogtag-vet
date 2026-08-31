import {z} from "zod";
import {hex32, hexAddress, hexSignature65, nonNegativeIntegerString, unixSeconds} from "@/lib/schemas/common";
import {openedLeafSchema} from "@/lib/schemas/mintSession";

export const bookingClientSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email(),
  phone: z.string().trim().optional(),
});

/**
 * The signed wallet claim - plans/wp4.4-mobile-booking-protocol.md section 2. Deliberately has NO
 * slot for `clinic` or `bookingHash`, even though both are fields of the signed `MobileBooking`
 * struct: the server ALWAYS rebuilds both itself (`clinic` from this clinic's own
 * `ClinicSettings.cloneAddress`, never a value the wire could claim to be; `bookingHash` from the
 * canonical booking content, `lib/booking/bookingHash.ts`) - accepting either from the wire would
 * let a request claim a domain/binding it never actually signed over.
 */
export const mobileWalletClaimSchema = z.object({
  address: hexAddress,
  signature: hexSignature65,
  issuedAt: unixSeconds,
  deadline: unixSeconds,
});

/**
 * The tag claim - plans/wp4.4-mobile-booking-protocol.md sections 1 and 3.4. `leaves` +
 * `reservedLeafHashes` are Q3's level-2 verification data (the pet's FULL opened profile-tree
 * leaves, mirroring `CustodialBindRequest`'s own shape/caps exactly - `@dogtag/standard`'s frozen
 * 64-leaf tree, 3 reserved + up to 61 opened): present ONLY when the app is asking the server to
 * attempt a verified provisional import, absent when the booking is asking for appointment-level
 * annotation only. The two travel together or not at all - a request with one but not the other is
 * a malformed shape, not a silently-downgraded one, so it is REJECTED outright rather than treated
 * as "no verification data sent" (fail loud on a shape the client clearly got wrong, per this
 * repo's usual strictness on wire shape).
 */
export const mobilePetClaimSchema = z
  .object({
    dogTagIdDec: z
      .string()
      .trim()
      .regex(/^\d+$/, "Must be a non-negative decimal integer string")
      .optional(),
    dogTagIdField: nonNegativeIntegerString.optional(),
    name: z.string().trim().optional(),
    leaves: z.array(openedLeafSchema).max(61).optional(),
    reservedLeafHashes: z.array(hex32).length(3).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.dogTagIdDec && !value.dogTagIdField) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: "A tag claim requires dogTagIdDec and/or dogTagIdField."});
    }
    if (Boolean(value.leaves) !== Boolean(value.reservedLeafHashes)) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: "leaves and reservedLeafHashes must both be present or both be absent."});
    }
  });

export const mobileBookingBlockSchema = z.object({
  source: z.literal("dogtag_app"),
  wallet: mobileWalletClaimSchema.optional(),
  pet: mobilePetClaimSchema.optional(),
});

export const bookAppointmentRequestSchema = z.object({
  serviceId: z.string().trim().min(1),
  startAt: z.string().datetime({offset: true}),
  client: bookingClientSchema,
  petName: z.string().trim().optional(),
  notes: z.string().max(2000).optional(),
  /** WP4.4 section 1 - optional, backward compatible: an old client that never sends this keeps
   * working untouched (zod strips unknown fields by default, so today's clients that don't even
   * know this key exists are unaffected either way). */
  mobile: mobileBookingBlockSchema.optional(),
});
export type BookAppointmentRequestInput = z.infer<typeof bookAppointmentRequestSchema>;

export const bookingAvailabilityQuerySchema = z.object({
  serviceId: z.string().trim().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});
