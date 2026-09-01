/** Shared shapes for the availability engine - deliberately plain data, not the mongoose
 * documents, so this whole library stays pure and unit-testable without a database. */

export interface AvailabilityRuleLike {
  dayOfWeek: number; // 0 = Sunday .. 6 = Saturday
  startMinute: number;
  endMinute: number;
  capacity: number;
}

export interface AvailabilityWindowLike {
  startMinute: number;
  endMinute: number;
  capacity: number;
}

export interface AvailabilityExceptionLike {
  date: string; // ISO date, clinic-local
  closed: boolean;
  windows?: AvailabilityWindowLike[];
}

export interface BookingSettingsLike {
  timezone: string;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  slotGranularityMinutes: number;
  /** WP4.7 D1 - duplicated as a literal union rather than importing `SchedulingMode` from
   * `models/Availability.ts`, matching this file's existing pattern of plain, dependency-free
   * shapes (e.g. `AvailabilityRuleLike` duplicates `AvailabilityRuleDoc`'s fields rather than
   * importing the mongoose-backed type) so this whole library stays pure and unit-testable
   * without ever reaching for a mongoose model.
   *
   * OPTIONAL here (unlike `BookingSettingsDoc`, where it is always present after `getBookingSettings
   * ()`'s own back-compat coalesce) deliberately - `computeAvailability` itself never reads this
   * field at all (mode dispatch happens one layer up, in `lifecycle.ts`), so requiring it would
   * force every existing `BookingSettingsLike` test fixture (`availability.test.ts`'s clinic-mode
   * byte-parity fixtures included) to grow a field they have no reason to care about. `lifecycle.ts`
   * treats an absent value as `"clinic"` by construction (`!== "practitioner"`), so this stays
   * correct even where the type permits an unset value the real runtime value never actually is. */
  schedulingMode?: "clinic" | "practitioner";
}

export interface ServiceForAvailability {
  durationMinutes: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
}

/** An already-buffered busy interval, in UTC unix seconds - i.e. what the appointment plus its
 * own service's buffers actually occupies. Precomputed by the caller (which has to join against
 * Service to find each appointment's buffer minutes anyway) so this library never needs DB
 * access. */
export interface OccupiedInterval {
  start: number;
  end: number;
}

/** One open window on one calendar date, after exceptions have been applied. */
export interface ResolvedWindow {
  startMinute: number;
  endMinute: number;
  capacity: number;
}

/** A bookable slot, in UTC unix seconds - the actual appointment span (buffers are not included;
 * they only affect which slots are offered/permitted, per `occupied.ts`). */
export interface AvailableSlot {
  startAt: number;
  endAt: number;
  capacity: number;
}
