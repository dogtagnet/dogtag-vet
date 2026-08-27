/** Minimal RFC 5545 ICS calendar generation - just enough for a one-event booking-confirmation
 * attachment and a read-only multi-event clinic feed. No external dependency: the format is a
 * small, fixed set of CRLF-joined lines. */

export interface IcsEvent {
  /** Globally unique per event, stable across regenerations of the same appointment. */
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  /** Unix seconds. */
  startAt: number;
  /** Unix seconds. */
  endAt: number;
  /** Unix seconds this VEVENT was created/last modified - defaults to `startAt` if omitted, only
   * to keep call sites simple; pass the real value when it's known. */
  dtstamp?: number;
  status?: "CONFIRMED" | "CANCELLED" | "TENTATIVE";
  organizerEmail?: string;
}

function toIcsDateUtc(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Folds a line per RFC 5545 section 3.1: lines longer than 75 octets are split with a leading
 * space on each continuation line. Escapes commas, semicolons, backslashes, and newlines in text
 * values first. */
function foldLine(line: string): string {
  const CHUNK = 75;
  if (line.length <= CHUNK) return line;
  const chunks: string[] = [];
  let rest = line;
  let first = true;
  while (rest.length > 0) {
    const size = first ? CHUNK : CHUNK - 1;
    chunks.push((first ? "" : " ") + rest.slice(0, size));
    rest = rest.slice(size);
    first = false;
  }
  return chunks.join("\r\n");
}

function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function buildVevent(event: IcsEvent): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${toIcsDateUtc(event.dtstamp ?? event.startAt)}`,
    `DTSTART:${toIcsDateUtc(event.startAt)}`,
    `DTEND:${toIcsDateUtc(event.endAt)}`,
    `SUMMARY:${escapeText(event.summary)}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.status) lines.push(`STATUS:${event.status}`);
  if (event.organizerEmail) lines.push(`ORGANIZER:mailto:${event.organizerEmail}`);
  lines.push("END:VEVENT");
  return lines;
}

/** A single-event `.ics` file, e.g. for a booking confirmation attachment. */
export function buildIcs(event: IcsEvent, options?: {prodId?: string}): string {
  return buildIcsCalendar([event], options);
}

/** A multi-event `.ics` calendar, e.g. the clinic's read-only appointments feed. */
export function buildIcsCalendar(events: IcsEvent[], options?: {prodId?: string}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${options?.prodId ?? "-//dogtag-vet//booking//EN"}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events.flatMap(buildVevent),
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Base64-encodes an `.ics` document for wire transport (`BookAppointmentResponse.ics` per
 * `vet-public-api.yaml`). */
export function icsToBase64(ics: string): string {
  return Buffer.from(ics, "utf8").toString("base64");
}
