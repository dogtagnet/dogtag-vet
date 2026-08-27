"use client";

import {useState} from "react";
import {Button, Input} from "@/components/ui/controls";
import {FormField, FormSection} from "@/components/ui/FormSection";
import {useSnackbar} from "@/components/ui/Snackbar";
import type {AvailabilityExceptionDoc, AvailabilityRuleDoc, BookingSettingsDoc} from "@/lib/models/Availability";

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function minutesToTimeInput(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function timeInputToMinutes(value: string): number {
  const [h = "0", m = "0"] = value.split(":");
  return Number(h) * 60 + Number(m);
}

interface DayRow {
  dayOfWeek: number;
  ruleId?: string;
  open: boolean;
  startMinute: number;
  endMinute: number;
  capacity: number;
}

function buildRows(rules: AvailabilityRuleDoc[]): DayRow[] {
  return Array.from({length: 7}, (_, dayOfWeek) => {
    const rule = rules.find((r) => r.dayOfWeek === dayOfWeek);
    return rule
      ? {dayOfWeek, ruleId: rule.ruleId, open: true, startMinute: rule.startMinute, endMinute: rule.endMinute, capacity: rule.capacity}
      : {dayOfWeek, open: false, startMinute: 9 * 60, endMinute: 17 * 60, capacity: 1};
  });
}

/**
 * Booking configuration (wp4-vet.md's Settings section) - the clinic's timezone, notice/advance
 * windows and slot granularity, plus a one-window-per-weekday hours editor and a simple date
 * exceptions list. Every save recomputes the full weekly schedule from scratch (delete + recreate
 * each day's rule) rather than diffing - the rule set is tiny (at most 7 rows) so this is simpler
 * than tracking per-row dirty state, at the cost of ruleId churn callers must not rely on.
 */
export function BookingConfigSection({
  settings,
  rules,
  exceptions,
}: {
  settings: BookingSettingsDoc;
  rules: AvailabilityRuleDoc[];
  exceptions: AvailabilityExceptionDoc[];
}) {
  const snackbar = useSnackbar();
  const [timezone, setTimezone] = useState(settings.timezone);
  const [minNoticeMinutes, setMinNoticeMinutes] = useState(String(settings.minNoticeMinutes));
  const [maxAdvanceDays, setMaxAdvanceDays] = useState(String(settings.maxAdvanceDays));
  const [slotGranularityMinutes, setSlotGranularityMinutes] = useState(String(settings.slotGranularityMinutes));
  const [rows, setRows] = useState<DayRow[]>(() => buildRows(rules));
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingHours, setSavingHours] = useState(false);
  const [exceptionList, setExceptionList] = useState(exceptions);
  const [newExceptionDate, setNewExceptionDate] = useState("");

  function updateRow(dayOfWeek: number, patch: Partial<DayRow>) {
    setRows((prev) => prev.map((row) => (row.dayOfWeek === dayOfWeek ? {...row, ...patch} : row)));
  }

  async function saveSettings() {
    setSavingSettings(true);
    try {
      const res = await fetch("/api/availability/settings", {
        method: "PATCH",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          timezone,
          minNoticeMinutes: Number(minNoticeMinutes),
          maxAdvanceDays: Number(maxAdvanceDays),
          slotGranularityMinutes: Number(slotGranularityMinutes),
        }),
      });
      if (!res.ok) throw new Error("Save failed");
      snackbar.show("Booking settings saved", "ok");
    } catch {
      snackbar.show("Could not save booking settings - try again", "danger");
    } finally {
      setSavingSettings(false);
    }
  }

  async function saveHours() {
    setSavingHours(true);
    try {
      await Promise.all(rows.filter((r) => r.ruleId).map((r) => fetch(`/api/availability/rules/${r.ruleId}`, {method: "DELETE"})));
      await Promise.all(
        rows
          .filter((r) => r.open)
          .map((r) =>
            fetch("/api/availability/rules", {
              method: "POST",
              headers: {"Content-Type": "application/json"},
              body: JSON.stringify({
                dayOfWeek: r.dayOfWeek,
                startMinute: r.startMinute,
                endMinute: r.endMinute,
                capacity: r.capacity,
              }),
            }),
          ),
      );
      snackbar.show("Weekly hours saved", "ok");
    } catch {
      snackbar.show("Could not save weekly hours - try again", "danger");
    } finally {
      setSavingHours(false);
    }
  }

  async function addException() {
    if (!newExceptionDate) return;
    const res = await fetch("/api/availability/exceptions", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({date: newExceptionDate, closed: true}),
    });
    if (res.ok) {
      const created = await res.json();
      setExceptionList((prev) => [...prev, created].sort((a, b) => a.date.localeCompare(b.date)));
      setNewExceptionDate("");
      snackbar.show("Closure added", "ok");
    } else {
      snackbar.show("Could not add closure", "danger");
    }
  }

  async function removeException(exceptionId: string) {
    const res = await fetch(`/api/availability/exceptions/${exceptionId}`, {method: "DELETE"});
    if (res.ok) setExceptionList((prev) => prev.filter((e) => e.exceptionId !== exceptionId));
  }

  return (
    <>
      <FormSection title="Booking configuration" helperText="Governs the public booking page and the availability engine.">
        <FormField label="Timezone" htmlFor="booking-timezone" helperText="An IANA zone, e.g. America/New_York.">
          <Input id="booking-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </FormField>
        <FormField label="Minimum notice (minutes)" htmlFor="min-notice">
          <Input
            id="min-notice"
            type="number"
            min={0}
            value={minNoticeMinutes}
            onChange={(e) => setMinNoticeMinutes(e.target.value)}
          />
        </FormField>
        <FormField label="Maximum advance (days)" htmlFor="max-advance">
          <Input
            id="max-advance"
            type="number"
            min={1}
            value={maxAdvanceDays}
            onChange={(e) => setMaxAdvanceDays(e.target.value)}
          />
        </FormField>
        <FormField label="Slot granularity (minutes)" htmlFor="slot-granularity">
          <Input
            id="slot-granularity"
            type="number"
            min={5}
            value={slotGranularityMinutes}
            onChange={(e) => setSlotGranularityMinutes(e.target.value)}
          />
        </FormField>
        <div className="flex justify-end">
          <Button variant="secondary" onClick={saveSettings} disabled={savingSettings}>
            {savingSettings ? "Saving..." : "Save booking configuration"}
          </Button>
        </div>
      </FormSection>

      <FormSection title="Weekly hours" helperText="One open window per day; use exceptions below for holidays or one-off changes.">
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.dayOfWeek} className="flex flex-wrap items-center gap-3">
              <label className="flex w-32 items-center gap-2 text-body text-ink">
                <input type="checkbox" checked={row.open} onChange={(e) => updateRow(row.dayOfWeek, {open: e.target.checked})} />
                {DAY_LABELS[row.dayOfWeek]}
              </label>
              {row.open && (
                <>
                  <Input
                    type="time"
                    value={minutesToTimeInput(row.startMinute)}
                    onChange={(e) => updateRow(row.dayOfWeek, {startMinute: timeInputToMinutes(e.target.value)})}
                    className="w-32"
                  />
                  <span className="text-body text-ink-muted">to</span>
                  <Input
                    type="time"
                    value={minutesToTimeInput(row.endMinute)}
                    onChange={(e) => updateRow(row.dayOfWeek, {endMinute: timeInputToMinutes(e.target.value)})}
                    className="w-32"
                  />
                  <Input
                    type="number"
                    min={1}
                    value={row.capacity}
                    onChange={(e) => updateRow(row.dayOfWeek, {capacity: Number(e.target.value)})}
                    className="w-20"
                    aria-label="Capacity"
                  />
                  <span className="text-caption text-ink-faint">capacity</span>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <Button variant="secondary" onClick={saveHours} disabled={savingHours}>
            {savingHours ? "Saving..." : "Save weekly hours"}
          </Button>
        </div>
      </FormSection>

      <FormSection title="Closures" helperText="Dates the clinic is fully closed, overriding the weekly hours.">
        <ul className="space-y-1">
          {exceptionList.map((exception) => (
            <li key={exception.exceptionId} className="flex items-center justify-between text-body text-ink">
              <span>{exception.date}</span>
              <Button variant="ghost" onClick={() => removeException(exception.exceptionId)}>
                Remove
              </Button>
            </li>
          ))}
          {exceptionList.length === 0 && <li className="text-body text-ink-faint">No closures added.</li>}
        </ul>
        <div className="flex items-center gap-2">
          <Input type="date" value={newExceptionDate} onChange={(e) => setNewExceptionDate(e.target.value)} />
          <Button variant="secondary" onClick={addException}>
            Add closure
          </Button>
        </div>
      </FormSection>
    </>
  );
}
