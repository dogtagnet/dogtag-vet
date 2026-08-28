import {fromZonedTime, toZonedTime} from "date-fns-tz";

/** Parses `"YYYY-MM-DD"` into its numeric components. Throws on a malformed date string - every
 * call site in this file receives dates it produced itself or that were validated by a zod
 * schema upstream (`isoDate`), so this is a defensive assertion, not user-facing input handling. */
function parseDateStr(dateStr: string): {year: number; month: number; day: number} {
  const parts = dateStr.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (parts.length !== 3 || [year, month, day].some(Number.isNaN)) {
    throw new Error(`Invalid ISO date string: "${dateStr}"`);
  }
  return {year, month, day};
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Convert a clinic-local calendar date + minute-of-day into a UTC unix-seconds instant, DST-safe
 * and - critically - independent of the *host* process's own timezone (the two are easy to
 * conflate, since both `date-fns-tz` and plain `Date` locals getters/setters are involved
 * somewhere in most approaches to this conversion).
 *
 * `fromZonedTime` has two call conventions: given a `Date` object, it reads the *host-local*
 * getters (`getFullYear`/`getHours`/...) as "the wall-clock value to convert" - which means
 * building that `Date` via the host-local constructor (`new Date(y, m, d, h, mi)`) is a trap: if
 * the HOST's own timezone happens to have a DST transition at that same wall-clock reading
 * (unrelated to the clinic's own timezone - and a common coincidence for a vet self-hosting in
 * their own timezone), the constructor silently normalizes the "impossible" reading to a
 * different, valid one *before* `fromZonedTime` ever sees it, defeating the whole point of the
 * DST-gap check below. Given a plain ISO-like *string* with no trailing `Z`/offset instead,
 * `fromZonedTime` parses the Y/M/D/H/M components directly via regex (see its source) and never
 * touches a host-local getter/setter - so that's the only path used here.
 *
 * `fromZonedTime` (either way) does not itself reject a nonexistent local time - it silently
 * picks some offset. So every conversion is verified with a round trip: convert the resulting
 * instant back to the same zone and compare the wall-clock *components* (year/month/day/hour/
 * minute, read via `toZonedTime` + local getters - safe here because the same write-then-read
 * pair on one process cancels out whatever the host's own zone is) against what was asked for. A
 * slot that fails this check is simply not offered (callers treat `null` as "not a valid
 * instant", not an error) rather than surfacing a slot that does not correspond to any real local
 * time.
 */
export function localDateMinuteToUtcSeconds(dateStr: string, minuteOfDay: number, timeZone: string): number | null {
  const {year, month, day} = parseDateStr(dateStr);
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  const isoLocal = `${year}-${pad2(month)}-${pad2(day)}T${pad2(hours)}:${pad2(minutes)}:00`;

  const utc = fromZonedTime(isoLocal, timeZone);
  if (Number.isNaN(utc.getTime())) return null;

  const roundTrip = toZonedTime(utc, timeZone);
  const matches =
    roundTrip.getFullYear() === year &&
    roundTrip.getMonth() === month - 1 &&
    roundTrip.getDate() === day &&
    roundTrip.getHours() === hours &&
    roundTrip.getMinutes() === minutes;
  if (!matches) return null;

  return Math.floor(utc.getTime() / 1000);
}

/** Day-of-week (0 = Sunday .. 6 = Saturday) for an ISO calendar date string. Calendar weekday
 * never depends on timezone, so this is computed directly from the Y/M/D components rather than
 * by parsing the string into a zoned Date (which would be timezone-sensitive for no reason). */
export function dayOfWeekForDateStr(dateStr: string): number {
  const {year, month, day} = parseDateStr(dateStr);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Add `days` calendar days to an ISO date string, returned as an ISO date string. Pure calendar
 * arithmetic (anchored at UTC midnight) - never touches a timezone, so it can't be thrown off by
 * a DST transition landing on the boundary. */
export function addCalendarDays(dateStr: string, days: number): string {
  const {year, month, day} = parseDateStr(dateStr);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return d.toISOString().slice(0, 10);
}

/** ISO calendar date string (clinic-local) for a UTC unix-seconds instant. Reading `toZonedTime`'s
 * result through *local* getters is safe regardless of the host's own timezone: `toZonedTime`
 * writes the target zone's wall-clock value via host-local setters, so reading it back via
 * host-local getters on the same object is a self-cancelling round trip - see
 * `localDateMinuteToUtcSeconds`'s doc comment for the case (host-local *construction* of the
 * input) that is NOT safe. */
export function utcSecondsToLocalDateStr(utcSeconds: number, timeZone: string): string {
  const zoned = toZonedTime(new Date(utcSeconds * 1000), timeZone);
  const year = zoned.getFullYear();
  const month = String(zoned.getMonth() + 1).padStart(2, "0");
  const day = String(zoned.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Clinic-local minutes-since-midnight for a UTC unix-seconds instant (companion to
 * `utcSecondsToLocalDateStr` - together they invert `localDateMinuteToUtcSeconds`). */
export function utcSecondsToLocalMinuteOfDay(utcSeconds: number, timeZone: string): number {
  const zoned = toZonedTime(new Date(utcSeconds * 1000), timeZone);
  return zoned.getHours() * 60 + zoned.getMinutes();
}

/** Today's ISO calendar date in the clinic's timezone, read directly off `Intl` rather than via
 * `toZonedTime` + local getters (both work; this is the simpler of the two for "right now" since
 * there is no instant to convert back from). Shared by `/calendar` and `/dashboard` so "today"
 * means the same clinic-local day on both. */
export function todayInTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {timeZone, year: "numeric", month: "2-digit", day: "2-digit"}).format(
    new Date(),
  );
}
