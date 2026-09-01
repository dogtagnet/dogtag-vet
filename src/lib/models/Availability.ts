import {Schema} from "mongoose";
import {randomUUID} from "node:crypto";
import {getOrCreateModel} from "@/lib/models/registerModel";

/** Weekly recurring open windows. `dayOfWeek`: 0 = Sunday .. 6 = Saturday.
 *
 * WP4.7 A3/D2: `staffId` (optional, indexed) scopes a rule to ONE bookable practitioner's own
 * weekly hours - a rule with no `staffId` remains part of the clinic-wide set Whole-clinic mode
 * (and every rule created before this WP) uses exclusively. Per-practitioner mode's engine
 * (A4) reads a practitioner's rules by matching `staffId`; the clinic-wide read path
 * (`loadAvailabilityConfig`, unchanged) keeps loading every rule regardless of `staffId` and it is
 * up to A4's practitioner-mode pass to filter - so this field's mere existence changes nothing
 * about Whole-clinic mode's behavior. */
export interface AvailabilityRuleDoc {
  ruleId: string;
  dayOfWeek: number;
  startMinute: number; // minutes since local midnight
  endMinute: number;
  capacity: number;
  staffId?: string;
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
    staffId: {type: String, index: true},
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

/**
 * WP4.7 A3/D2/D3: `staffId` (optional, indexed) scopes a closure/override to ONE bookable
 * practitioner - absent means whole-clinic, exactly as every exception before this WP. Multiple
 * practitioners routinely need INDEPENDENT date exceptions on the identical calendar date (two
 * vets taking different days off that happen to coincide is normal, not a corner case) - see
 * `wp4.7-vet-role-practitioner-availability.md` A5/A6, "closures gain optional practitioner
 * scoping". This is why uniqueness moved from `date` ALONE to the COMPOUND `{date, staffId}` pair
 * below: a bare per-field `unique` on `date` (this model's shape before this WP) would make a
 * second practitioner's exception on an already-used date a duplicate-key error.
 *
 * LIVE-DB MIGRATION NOTE (read before assuming this "just works" everywhere): an already-deployed
 * database created before this change physically carries the OLD single-field unique index on
 * `date` (Mongo does not retroactively alter or drop an index just because the owning schema no
 * longer declares it - `getOrCreateModel`'s drift detection re-registers the MODEL, it does not
 * run `syncIndexes()`, deliberately: forcing an automatic index sync on every schema-drift
 * re-registration would apply to every model in the app, on whatever database happens to be
 * connected, which is far too broad a hammer for this one field). Until an operator runs the
 * one-time migration - `db.availabilityexceptions.dropIndex("date_1")` - on such a database, the
 * stale index keeps enforcing the OLD one-exception-per-date-period rule: a second practitioner's
 * exception on a date already taken (by the clinic-wide set or another practitioner) fails closed
 * with a clear, specific error (`POST /api/availability/exceptions` - see its own doc comment on
 * the E11000 mapping) rather than corrupting data or double-booking anyone. A freshly created
 * database (any e2e run, any brand-new clone) never had the old index to begin with and gets the
 * correct compound-unique behavior immediately.
 */
export interface AvailabilityExceptionDoc {
  exceptionId: string;
  date: string; // ISO date, clinic-local
  closed: boolean;
  windows?: AvailabilityWindow[];
  note?: string;
  staffId?: string;
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
    // No more per-field `unique` here - see the compound index below and this interface's own doc
    // comment on why (and on the live-DB migration a pre-existing deployment still needs).
    date: {type: String, required: true, index: true},
    closed: {type: Boolean, required: true, default: false},
    windows: {type: [availabilityWindowSchema], default: undefined},
    note: String,
    staffId: {type: String, index: true},
  },
  {timestamps: true},
);

// At most one exception per (date, staffId) pair - staffId ABSENT is itself a distinct value as
// far as this index is concerned (every clinic-wide exception shares that "missing" value), so
// this preserves today's "at most one clinic-wide exception per date" invariant unchanged while
// additionally allowing each practitioner their own independent exception on any date, including
// one a clinic-wide (or another practitioner's) exception already occupies.
availabilityExceptionSchema.index({date: 1, staffId: 1}, {unique: true});

export const AvailabilityException = getOrCreateModel<AvailabilityExceptionDoc>(
  "AvailabilityException",
  availabilityExceptionSchema,
);

export type SchedulingMode = "clinic" | "practitioner";

/** Singleton clinic-wide booking configuration. Always exactly one document; read/write through
 * getBookingSettings()/upsert rather than a raw find, so callers never have to think about the
 * singleton invariant. */
export interface BookingSettingsDoc {
  _id: string; // always the fixed singleton id - see BOOKING_SETTINGS_ID below
  timezone: string; // IANA, e.g. "America/Los_Angeles"
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  slotGranularityMinutes: number;
  /** WP4.7 D1: "clinic" (default, today's exact behavior) or "practitioner" (per-practitioner
   * availability, A4). Guarded in the settings UI (A5) to refuse switching to "practitioner"
   * until >= 1 bookable practitioner with >= 1 weekly rule exists. */
  schedulingMode: SchedulingMode;
  updatedAt: Date;
}

const bookingSettingsSchema = new Schema<BookingSettingsDoc>(
  {
    _id: {type: String, required: true},
    timezone: {type: String, required: true, default: "America/New_York"},
    minNoticeMinutes: {type: Number, required: true, default: 60, min: 0},
    maxAdvanceDays: {type: Number, required: true, default: 60, min: 1},
    slotGranularityMinutes: {type: Number, required: true, default: 15, min: 5},
    schedulingMode: {type: String, enum: ["clinic", "practitioner"], required: true, default: "clinic"},
  },
  {timestamps: {createdAt: false, updatedAt: true}},
);

export const BookingSettings = getOrCreateModel<BookingSettingsDoc>("BookingSettings", bookingSettingsSchema);

const BOOKING_SETTINGS_ID = "singleton";

export async function getBookingSettings(): Promise<BookingSettingsDoc> {
  const existing = await BookingSettings.findOne({_id: BOOKING_SETTINGS_ID}).lean<BookingSettingsDoc>();
  if (existing) {
    // Back-compat: `.lean()` returns the document EXACTLY as stored, bypassing mongoose's own
    // schema-default hydration - a singleton created before `schedulingMode` existed (the live
    // UAT DB's own row, right now) reads back with the key entirely absent, not defaulted to
    // "clinic" just because the schema says so. Every caller of this function (the availability
    // engine included, A4) must see a real `SchedulingMode` value, never `undefined` sneaking
    // past the type, so this is the one place that coalesces rather than trusting mongoose.
    return {...existing, schedulingMode: existing.schedulingMode ?? "clinic"};
  }
  const created = await BookingSettings.create({_id: BOOKING_SETTINGS_ID});
  return created.toObject();
}
