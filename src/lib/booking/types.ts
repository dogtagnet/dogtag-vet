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
