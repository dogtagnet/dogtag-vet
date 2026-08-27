import {z} from "zod";
import {unixSeconds} from "@/lib/schemas/common";

export const createAppointmentSchema = z.object({
  clientId: z.string().optional(),
  petId: z.string().optional(),
  serviceId: z.string().optional(),
  staffName: z.string().optional(),
  startAt: unixSeconds,
  endAt: unixSeconds,
  notes: z.string().max(2000).optional(),
  source: z.enum(["staff", "public_booking", "mobile"]),
  clientName: z.string().trim().min(1),
  petName: z.string().trim().min(1),
});
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;

/** The staff calendar's click-to-create form works in clinic-local wall-clock terms (a date and a
 * time-of-day on the grid), not unix seconds - this is the shape `/api/appointments/from-local-time`
 * accepts, resolving `localIso` through the same DST-safe conversion the booking engine uses
 * server-side rather than duplicating that logic in the browser. */
export const createAppointmentFromLocalTimeSchema = z.object({
  localIso: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "Must be an offset-free local ISO datetime"),
  durationMinutes: z.number().int().min(1),
  serviceId: z.string().optional(),
  notes: z.string().max(2000).optional(),
  clientName: z.string().trim().min(1),
  petName: z.string().trim().min(1),
});
export type CreateAppointmentFromLocalTimeInput = z.infer<typeof createAppointmentFromLocalTimeSchema>;

export const updateAppointmentStatusSchema = z.object({
  status: z.enum(["scheduled", "confirmed", "in_progress", "completed", "cancelled", "no_show"]),
});

export const listAppointmentsQuerySchema = z.object({
  q: z.string().optional(),
  clientId: z.string().optional(),
  petId: z.string().optional(),
  status: z.enum(["scheduled", "confirmed", "in_progress", "completed", "cancelled", "no_show"]).optional(),
  from: unixSeconds.optional(),
  to: unixSeconds.optional(),
});
