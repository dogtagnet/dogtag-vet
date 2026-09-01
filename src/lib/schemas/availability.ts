import {z} from "zod";
import {isoDate} from "@/lib/schemas/common";
import {isValidTimeZone} from "@/lib/timezones";

export const availabilityRuleSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1440),
  endMinute: z.number().int().min(0).max(1440),
  capacity: z.number().int().min(1).default(1),
}).refine((v) => v.endMinute > v.startMinute, {
  message: "endMinute must be after startMinute",
  path: ["endMinute"],
});
export type AvailabilityRuleInput = z.infer<typeof availabilityRuleSchema>;

export const availabilityWindowSchema = z.object({
  startMinute: z.number().int().min(0).max(1440),
  endMinute: z.number().int().min(0).max(1440),
  capacity: z.number().int().min(1).default(1),
});

export const availabilityExceptionSchema = z.object({
  date: isoDate,
  closed: z.boolean().default(false),
  windows: z.array(availabilityWindowSchema).optional(),
  note: z.string().optional(),
});
export type AvailabilityExceptionInput = z.infer<typeof availabilityExceptionSchema>;

export const bookingSettingsSchema = z.object({
  // Refined on the FIELD, not the whole object, so bookingSettingsSchema stays a plain ZodObject
  // (.shape/.partial() etc. keep working for any future caller) rather than becoming a ZodEffects.
  // isValidTimeZone try-constructs Intl.DateTimeFormat instead of testing
  // Intl.supportedValuesOf("timeZone") membership, so already-stored legacy aliases (UTC,
  // Etc/GMT+5) don't fail re-validation on their next save - see timezones.ts's doc comment.
  timezone: z.string().min(1).refine(isValidTimeZone, {message: "Must be a valid IANA timezone"}),
  minNoticeMinutes: z.number().int().min(0),
  maxAdvanceDays: z.number().int().min(1),
  slotGranularityMinutes: z.number().int().min(5),
});
export type BookingSettingsInput = z.infer<typeof bookingSettingsSchema>;
