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
