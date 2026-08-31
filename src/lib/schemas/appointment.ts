import {z} from "zod";
import {unixSeconds} from "@/lib/schemas/common";

/**
 * WP4.3 A1/C5: an appointment is either tagged (a real `clientId` plus at least one `petId`) or a
 * walk-in (no `clientId`, and the free-text `clientName`/`petName` carry the display strings
 * instead) - never a mix. Shared by both create schemas below so the two creation paths (staff's
 * generic POST, the calendar's from-local-time POST) enforce the identical rule instead of two
 * schemas quietly drifting apart.
 */
function refineTaggedOrWalkIn(
  data: {clientId?: string; petIds?: string[]; clientName?: string; petName?: string},
  ctx: z.RefinementCtx,
): void {
  if (!data.clientId) {
    if (!data.clientName) {
      ctx.addIssue({code: z.ZodIssueCode.custom, path: ["clientName"], message: "Client name is required for a walk-in appointment."});
    }
    if (!data.petName) {
      ctx.addIssue({code: z.ZodIssueCode.custom, path: ["petName"], message: "Pet name is required for a walk-in appointment."});
    }
  } else if (!data.petIds || data.petIds.length === 0) {
    ctx.addIssue({code: z.ZodIssueCode.custom, path: ["petIds"], message: "At least one pet is required when tagging a client."});
  }
}

export const createAppointmentSchema = z
  .object({
    clientId: z.string().optional(),
    petIds: z.array(z.string()).optional(),
    serviceId: z.string().optional(),
    staffName: z.string().optional(),
    startAt: unixSeconds,
    endAt: unixSeconds,
    notes: z.string().max(2000).optional(),
    source: z.enum(["staff", "public_booking", "mobile"]),
    // Required end to end (schema + mongoose) when walk-in; when `clientId` is set the server
    // re-derives both from the tagged records instead (see refineTaggedOrWalkIn above and
    // lib/booking/appointmentTagging.ts's `resolveTagging`), so they are optional at the wire level.
    clientName: z.string().trim().optional(),
    petName: z.string().trim().optional(),
  })
  .superRefine(refineTaggedOrWalkIn);
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;

/** The staff calendar's click-to-create form works in clinic-local wall-clock terms (a date and a
 * time-of-day on the grid), not unix seconds - this is the shape `/api/appointments/from-local-time`
 * accepts, resolving `localIso` through the same DST-safe conversion the booking engine uses
 * server-side rather than duplicating that logic in the browser. Same tagged-or-walk-in rule as
 * `createAppointmentSchema` above (WP4.3 C5). */
export const createAppointmentFromLocalTimeSchema = z
  .object({
    localIso: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "Must be an offset-free local ISO datetime"),
    durationMinutes: z.number().int().min(1),
    serviceId: z.string().optional(),
    notes: z.string().max(2000).optional(),
    clientId: z.string().optional(),
    petIds: z.array(z.string()).optional(),
    clientName: z.string().trim().optional(),
    petName: z.string().trim().optional(),
  })
  .superRefine(refineTaggedOrWalkIn);
export type CreateAppointmentFromLocalTimeInput = z.infer<typeof createAppointmentFromLocalTimeSchema>;

const appointmentStatusEnum = z.enum(["scheduled", "confirmed", "in_progress", "completed", "cancelled", "no_show"]);

/**
 * `PATCH /api/appointments/:id` (WP4.3 C6). Every field is independently optional - a caller
 * changes only what it mentions. `clientId` is nullable, not just optional: omitting the key
 * leaves the tag untouched (`undefined` after parsing, since JSON has no way to send a literal
 * `undefined`), while `null` is the explicit untag. `petIds`, when provided, always REPLACES the
 * full array (there is no add/remove-one wire shape) - the route still enforces
 * `isTaggingConsistent` against the resulting {clientId, petIds} pair, so e.g. clearing `clientId`
 * to `null` must pair with `petIds: []` in the same request (see docs/appointments.md).
 */
export const updateAppointmentSchema = z.object({
  status: appointmentStatusEnum.optional(),
  clientId: z.string().min(1).nullable().optional(),
  petIds: z.array(z.string()).optional(),
  notes: z.string().max(2000).optional(),
});
export type UpdateAppointmentInput = z.infer<typeof updateAppointmentSchema>;

export const listAppointmentsQuerySchema = z.object({
  q: z.string().optional(),
  clientId: z.string().optional(),
  petId: z.string().optional(),
  status: appointmentStatusEnum.optional(),
  from: unixSeconds.optional(),
  to: unixSeconds.optional(),
});
