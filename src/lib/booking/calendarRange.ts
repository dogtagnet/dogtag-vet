import {addCalendarDays, dayOfWeekForDateStr, localDateMinuteToUtcSeconds} from "@/lib/booking/dst";

/** The Monday that starts the calendar week containing `dateStr` (ISO date, clinic-local). Weeks
 * always start on Monday regardless of locale - a fixed, simple convention for a single-clinic
 * staff calendar rather than a per-viewer locale setting. */
export function startOfWeek(dateStr: string): string {
  const dow = dayOfWeekForDateStr(dateStr); // 0 = Sunday .. 6 = Saturday
  const daysSinceMonday = (dow + 6) % 7;
  return addCalendarDays(dateStr, -daysSinceMonday);
}

export interface CalendarRange {
  /** Clinic-local ISO dates in the visible range, inclusive. */
  dates: string[];
  fromUtc: number;
  toUtc: number;
}

/** The UTC instant range spanning `days` clinic-local calendar days starting at `startDateStr`,
 * for querying appointments to render on the grid. */
export function calendarRangeFor(startDateStr: string, days: number, timeZone: string): CalendarRange {
  const dates = Array.from({length: days}, (_, i) => addCalendarDays(startDateStr, i));
  const endDateStr = addCalendarDays(startDateStr, days);
  return {
    dates,
    fromUtc: robustLocalMidnightUtc(startDateStr, timeZone),
    toUtc: robustLocalMidnightUtc(endDateStr, timeZone),
  };
}

/** Local midnight, DST-gap-tolerant: on the vanishingly rare date/zone where midnight itself
 * falls inside a spring-forward gap, nudges forward a few minutes at a time until it lands on a
 * real instant. Only used for calendar display range boundaries, never for a specific slot's
 * correctness. */
function robustLocalMidnightUtc(dateStr: string, timeZone: string): number {
  for (let minute = 0; minute < 60; minute++) {
    const utc = localDateMinuteToUtcSeconds(dateStr, minute, timeZone);
    if (utc !== null) return utc - minute * 60;
  }
  throw new Error(`Could not resolve local midnight for ${dateStr} in ${timeZone}`);
}
