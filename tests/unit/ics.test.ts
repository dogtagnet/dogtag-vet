import {describe, expect, it} from "vitest";
import {buildIcs, buildIcsCalendar, icsToBase64} from "@/lib/ics";

const sampleEvent = {
  uid: "apt-123@dogtag-vet",
  summary: "Annual checkup - Rex",
  description: "Bring vaccination records",
  location: "Main St Vet Clinic",
  startAt: Date.parse("2026-01-15T14:00:00Z") / 1000,
  endAt: Date.parse("2026-01-15T14:30:00Z") / 1000,
  status: "CONFIRMED" as const,
};

describe("buildIcs", () => {
  it("produces a valid single-event VCALENDAR with CRLF line endings", () => {
    const ics = buildIcs(sampleEvent);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("BEGIN:VEVENT\r\n");
    expect(ics).toContain("END:VEVENT\r\n");
    expect(ics).toContain("UID:apt-123@dogtag-vet\r\n");
    expect(ics).toContain("SUMMARY:Annual checkup - Rex\r\n");
    expect(ics).toContain("STATUS:CONFIRMED\r\n");
  });

  it("formats DTSTART/DTEND as basic-format UTC instants", () => {
    const ics = buildIcs(sampleEvent);
    expect(ics).toContain("DTSTART:20260115T140000Z\r\n");
    expect(ics).toContain("DTEND:20260115T143000Z\r\n");
  });

  it("escapes commas, semicolons, and newlines in text fields", () => {
    const ics = buildIcs({...sampleEvent, summary: "Checkup; vaccines, boosters\nfollow-up"});
    expect(ics).toContain("SUMMARY:Checkup\\; vaccines\\, boosters\\nfollow-up\r\n");
  });

  it("folds lines longer than 75 octets with a leading-space continuation", () => {
    const longSummary = "A".repeat(120);
    const ics = buildIcs({...sampleEvent, summary: longSummary});
    const lines = ics.split("\r\n");
    // The folded SUMMARY line's first physical line is at most 75 octets, and its continuation
    // starts with a space.
    const summaryLineIndex = lines.findIndex((l) => l.startsWith("SUMMARY:"));
    expect(lines.at(summaryLineIndex)?.length).toBeLessThanOrEqual(75);
    expect(lines.at(summaryLineIndex + 1)?.startsWith(" ")).toBe(true);
  });
});

describe("buildIcsCalendar", () => {
  it("emits one VEVENT per event in a single VCALENDAR", () => {
    const ics = buildIcsCalendar([sampleEvent, {...sampleEvent, uid: "apt-456@dogtag-vet"}]);
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
    expect(ics).toContain("UID:apt-123@dogtag-vet");
    expect(ics).toContain("UID:apt-456@dogtag-vet");
  });

  it("still produces a well-formed (empty) calendar with no events", () => {
    const ics = buildIcsCalendar([]);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).not.toContain("VEVENT");
  });
});

describe("icsToBase64", () => {
  it("round-trips through base64", () => {
    const ics = buildIcs(sampleEvent);
    const encoded = icsToBase64(ics);
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(ics);
  });
});
