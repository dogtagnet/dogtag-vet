import {z} from "zod";
import {isoDate} from "@/lib/schemas/common";
import {isValidTimeZone} from "@/lib/timezones";

export const availabilityRuleSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1440),
  endMinute: z.number().int().min(0).max(1440),
  capacity: z.number().int().min(1).default(1),
  // WP4.7 A3/D2: absent = the clinic-wide rule set (today's exact behavior); present = this ONE
  // practitioner's own weekly hours. Not validated against the Staff collection here (this schema
  // is DB-free by design, matching every other schema in this file) - the route/engine layer
  // (A4/A5) is responsible for only ever writing a real bookable practitioner's staffId.
  staffId: z.string().min(1).optional(),
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
  // WP4.7 A3/D2/D3: absent = whole-clinic (today's exact behavior, and the ONLY value ever written
  // before this WP); present = this one practitioner's own closure/override. See
  // `models/Availability.ts`'s `AvailabilityExceptionDoc` doc comment for the compound
  // (date, staffId) uniqueness this enables and the live-DB migration note.
  staffId: z.string().min(1).optional(),
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
  // WP4.7 D1 - optional here (unlike the mongoose schema's required-with-default): the existing
  // `PATCH /api/availability/settings` caller (BookingConfigSection today) never sends this field
  // at all, and `$set`-ing `parsed.data` must not silently reset schedulingMode back to "clinic"
  // on every unrelated settings save once A5 adds a dedicated mode-toggle control that PATCHes it
  // separately.
  schedulingMode: z.enum(["clinic", "practitioner"]).optional(),
});
export type BookingSettingsInput = z.infer<typeof bookingSettingsSchema>;
