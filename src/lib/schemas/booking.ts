import {z} from "zod";

export const bookingClientSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email(),
  phone: z.string().trim().optional(),
});

export const bookAppointmentRequestSchema = z.object({
  serviceId: z.string().trim().min(1),
  startAt: z.string().datetime({offset: true}),
  client: bookingClientSchema,
  petName: z.string().trim().optional(),
  notes: z.string().max(2000).optional(),
});
export type BookAppointmentRequestInput = z.infer<typeof bookAppointmentRequestSchema>;

export const bookingAvailabilityQuerySchema = z.object({
  serviceId: z.string().trim().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});
