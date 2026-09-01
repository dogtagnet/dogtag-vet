/**
 * Pure, unit-testable helpers behind `TimezonePicker` (WP4.5 issue 2) and the server-side
 * `bookingSettingsSchema` timezone guard - see plans/wp4.5-track12-plan.md.
 */

const DEFAULT_RESULT_LIMIT = 50;

/** Lowercases and turns IANA's `/`- and `_`-delimited zone id into plain words, e.g.
 * "America/New_York" -> ["america", "new york"] - one entry per `/`-delimited segment, so a query
 * can be ranked as a PREFIX of a segment (a region or city name) rather than only ever a substring
 * of the full id. */
function zoneSegments(zone: string): string[] {
  return zone.split("/").map((segment) => segment.replace(/_/g, " ").toLowerCase());
}

/**
 * Case-insensitive search over a list of IANA zone ids, `/` and `_` normalized to spaces so
 * "new york" matches "America/New_York". A query that PREFIXES some segment (a region or city
 * name) ranks ahead of a zone that only contains the query as a substring, so typing the start of
 * a city name reliably surfaces it first even when another zone's name happens to contain the same
 * letters mid-word. Returns nothing for an empty/whitespace query - mirrors `ClientPicker`'s own
 * "nothing until you type" convention rather than dumping the full ~400-zone list on focus.
 */
export function filterTimeZones(query: string, zones: readonly string[], limit = DEFAULT_RESULT_LIMIT): string[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];

  const prefixMatches: string[] = [];
  const substringMatches: string[] = [];
  for (const zone of zones) {
    const segments = zoneSegments(zone);
    if (segments.some((segment) => segment.startsWith(trimmed))) {
      prefixMatches.push(zone);
    } else if (segments.join(" ").includes(trimmed)) {
      substringMatches.push(zone);
    }
  }
  return [...prefixMatches, ...substringMatches].slice(0, limit);
}

/**
 * "UTC-04:00"-style label for `zone` at a given instant (defaults to now), via
 * `Intl.DateTimeFormat`'s `longOffset` - the only timezoneName style that always yields a numeric
 * offset ("GMT-04:00") rather than an abbreviation, and one that DST-shifts correctly per date
 * (New York is -05:00 in January, -04:00 in July). `longOffset` renders bare "GMT" (no digits) for
 * zero-offset zones - normalized to "UTC+00:00" so every label has the same "UTC±HH:MM" shape.
 */
export function utcOffsetLabel(zone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {timeZone: zone, timeZoneName: "longOffset"}).formatToParts(at);
  const raw = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+00:00";
  const label = raw.replace("GMT", "UTC");
  return label === "UTC" ? "UTC+00:00" : label;
}

/**
 * Whether `zone` is a constructible IANA timezone id, via try-constructing `Intl.DateTimeFormat`
 * rather than testing membership in `Intl.supportedValuesOf("timeZone")`. That list (the picker's
 * OWN search source) is the modern canonical set - it deliberately excludes legacy aliases like
 * "UTC" and "Asia/Calcutta" that the runtime still accepts and that real, already-stored data may
 * use. Membership-testing here would make already-valid stored zones fail re-validation.
 */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", {timeZone: zone});
    return true;
  } catch {
    return false;
  }
}
