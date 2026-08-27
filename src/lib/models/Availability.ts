import {Schema} from "mongoose";
import {randomUUID} from "node:crypto";
import {getOrCreateModel} from "@/lib/models/registerModel";

/** Weekly recurring open windows. `dayOfWeek`: 0 = Sunday .. 6 = Saturday. */
export interface AvailabilityRuleDoc {
  ruleId: string;
  dayOfWeek: number;
  startMinute: number; // minutes since local midnight
  endMinute: number;
  capacity: number;
  createdAt: Date;
  updatedAt: Date;
}

const availabilityRuleSchema = new Schema<AvailabilityRuleDoc>(
  {
    ruleId: {type: String, required: true, unique: true, default: () => randomUUID()},
    dayOfWeek: {type: Number, required: true, min: 0, max: 6},
    startMinute: {type: Number, required: true, min: 0, max: 1440},
    endMinute: {type: Number, required: true, min: 0, max: 1440},
    capacity: {type: Number, required: true, default: 1, min: 1},
  },
  {timestamps: true},
);

export const AvailabilityRule = getOrCreateModel<AvailabilityRuleDoc>(
  "AvailabilityRule",
  availabilityRuleSchema,
);

/** One-off override for a specific calendar date: fully closed, or a replacement set of windows
 * (each with its own capacity) that supersede the weekly rules for that date only. */
export interface AvailabilityWindow {
  startMinute: number;
  endMinute: number;
  capacity: number;
}

export interface AvailabilityExceptionDoc {
  exceptionId: string;
  date: string; // ISO date, clinic-local
  closed: boolean;
  windows?: AvailabilityWindow[];
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const availabilityWindowSchema = new Schema<AvailabilityWindow>(
  {
    startMinute: {type: Number, required: true, min: 0, max: 1440},
    endMinute: {type: Number, required: true, min: 0, max: 1440},
    capacity: {type: Number, required: true, default: 1, min: 1},
  },
  {_id: false},
);

const availabilityExceptionSchema = new Schema<AvailabilityExceptionDoc>(
  {
    exceptionId: {type: String, required: true, unique: true, default: () => randomUUID()},
    date: {type: String, required: true, unique: true, index: true},
    closed: {type: Boolean, required: true, default: false},
    windows: {type: [availabilityWindowSchema], default: undefined},
    note: String,
  },
  {timestamps: true},
);

export const AvailabilityException = getOrCreateModel<AvailabilityExceptionDoc>(
  "AvailabilityException",
  availabilityExceptionSchema,
);

/** Singleton clinic-wide booking configuration. Always exactly one document; read/write through
 * getBookingSettings()/upsert rather than a raw find, so callers never have to think about the
 * singleton invariant. */
export interface BookingSettingsDoc {
  _id: string; // always the fixed singleton id - see BOOKING_SETTINGS_ID below
  timezone: string; // IANA, e.g. "America/Los_Angeles"
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  slotGranularityMinutes: number;
  updatedAt: Date;
}

const bookingSettingsSchema = new Schema<BookingSettingsDoc>(
  {
    _id: {type: String, required: true},
    timezone: {type: String, required: true, default: "America/New_York"},
    minNoticeMinutes: {type: Number, required: true, default: 60, min: 0},
    maxAdvanceDays: {type: Number, required: true, default: 60, min: 1},
    slotGranularityMinutes: {type: Number, required: true, default: 15, min: 5},
  },
  {timestamps: {createdAt: false, updatedAt: true}},
);

export const BookingSettings = getOrCreateModel<BookingSettingsDoc>("BookingSettings", bookingSettingsSchema);

const BOOKING_SETTINGS_ID = "singleton";

export async function getBookingSettings(): Promise<BookingSettingsDoc> {
  const existing = await BookingSettings.findOne({_id: BOOKING_SETTINGS_ID}).lean<BookingSettingsDoc>();
  if (existing) return existing;
  const created = await BookingSettings.create({_id: BOOKING_SETTINGS_ID});
  return created.toObject();
}
