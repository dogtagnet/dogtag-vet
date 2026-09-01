"use client";

import {useEffect, useState} from "react";
import {Button, Input, Select} from "@/components/ui/controls";
import {FormField, FormSection} from "@/components/ui/FormSection";
import {useSnackbar} from "@/components/ui/Snackbar";
import {TimezonePicker} from "@/components/pickers/TimezonePicker";
import type {AvailabilityExceptionDoc, AvailabilityRuleDoc, BookingSettingsDoc, SchedulingMode} from "@/lib/models/Availability";
import type {PractitionerSummary} from "@/lib/booking/queries";

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Sentinel for the practitioner picker's "Whole clinic" option - a plain HTML `<select>` only
 * carries string values, and `""` reads naturally as "no staffId" without a separate constant
 * every call site has to import and compare against. */
const CLINIC_WIDE = "";

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

/** WP4.7 A5 - `scopeStaffId` filters `rules` to exactly one practitioner's own rows (or, when
 * `CLINIC_WIDE`, to the clinic-wide rows with no staffId at all) BEFORE building the 7-day array.
 * This is load-bearing, not cosmetic: `saveHours` below deletes every ruleId already present in
 * `rows` and recreates the open days from scratch, so if `rows` were ever built from the FULL,
 * unfiltered rule list, saving one practitioner's hours would silently delete every OTHER
 * practitioner's (and the clinic's own) rules too. Filtering here is what keeps `saveHours` scoped
 * to only the currently-selected practitioner (or the clinic) without saveHours itself needing to
 * know anything about scope. */
function buildRows(rules: AvailabilityRuleDoc[], scopeStaffId: string): DayRow[] {
  const scoped = rules.filter((r) => (scopeStaffId ? r.staffId === scopeStaffId : !r.staffId));
  return Array.from({length: 7}, (_, dayOfWeek) => {
    const rule = scoped.find((r) => r.dayOfWeek === dayOfWeek);
    return rule
      ? {dayOfWeek, ruleId: rule.ruleId, open: true, startMinute: rule.startMinute, endMinute: rule.endMinute, capacity: rule.capacity}
      : {dayOfWeek, open: false, startMinute: 9 * 60, endMinute: 17 * 60, capacity: 1};
  });
}

/**
 * Booking configuration (wp4-vet.md's Settings section) - the clinic's timezone, notice/advance
 * windows, slot granularity and scheduling mode, plus a per-scope weekly-hours editor and a date
 * exceptions list. Every hours save recomputes the full weekly schedule for the CURRENTLY SELECTED
 * scope from scratch (delete + recreate each day's rule, see `buildRows`'s doc comment) rather than
 * diffing - the rule set is tiny (at most 7 rows per scope) so this is simpler than tracking
 * per-row dirty state, at the cost of ruleId churn callers must not rely on.
 *
 * WP4.7 A5 (D1): the practitioner picker below the "Weekly hours" heading is ALWAYS shown,
 * regardless of the current scheduling mode - not just once already in practitioner mode. D1's own
 * precondition for switching TO practitioner mode is "at least one bookable practitioner already
 * has their own weekly hours", which would be impossible to ever satisfy if the only way to set a
 * practitioner's hours were to already be in practitioner mode first. Clinic mode's own hours stay
 * reachable via the picker's default "Whole clinic" option either way.
 */
export function BookingConfigSection({
  settings,
  rules,
  exceptions,
  practitioners,
  isOwner,
}: {
  settings: BookingSettingsDoc;
  rules: AvailabilityRuleDoc[];
  exceptions: AvailabilityExceptionDoc[];
  practitioners: PractitionerSummary[];
  /** WP4.7A orchestrator ruling R2 (FIX ROUND 1): only an owner may change `schedulingMode` -
   * the mode Select below is disabled (with an explanatory caption) for anyone else, and
   * `saveSettings` omits the field entirely from a non-owner's PATCH so every OTHER field here
   * stays saveable exactly as before. The PATCH route enforces this independently - this prop
   * only controls the UI's own presentation, matching this codebase's general defense-in-depth
   * pattern (see `hasPractitionerReadyForSchedulingMode`'s own doc comment). */
  isOwner: boolean;
}) {
  const snackbar = useSnackbar();
  const [timezone, setTimezone] = useState(settings.timezone);
  const [minNoticeMinutes, setMinNoticeMinutes] = useState(String(settings.minNoticeMinutes));
  const [maxAdvanceDays, setMaxAdvanceDays] = useState(String(settings.maxAdvanceDays));
  const [slotGranularityMinutes, setSlotGranularityMinutes] = useState(String(settings.slotGranularityMinutes));
  const [schedulingMode, setSchedulingMode] = useState<SchedulingMode>(settings.schedulingMode ?? "clinic");
  const [savingSettings, setSavingSettings] = useState(false);

  const [selectedPractitionerId, setSelectedPractitionerId] = useState(CLINIC_WIDE);
  const [rows, setRows] = useState<DayRow[]>(() => buildRows(rules, CLINIC_WIDE));
  const [savingHours, setSavingHours] = useState(false);

  const [exceptionList, setExceptionList] = useState(exceptions);
  const [newExceptionDate, setNewExceptionDate] = useState("");
  const [newExceptionStaffId, setNewExceptionStaffId] = useState(CLINIC_WIDE);

  // Re-derive the displayed rows whenever the picker's scope changes - see buildRows's doc comment
  // for why filtering happens before rows ever reaches component state. `rules` itself never
  // changes after the initial server-rendered load (no re-fetch after a save, matching this
  // component's existing "recompute from scratch" philosophy), so this only ever fires on a scope
  // change, never spuriously.
  useEffect(() => {
    setRows(buildRows(rules, selectedPractitionerId));
  }, [selectedPractitionerId, rules]);

  function updateRow(dayOfWeek: number, patch: Partial<DayRow>) {
    setRows((prev) => prev.map((row) => (row.dayOfWeek === dayOfWeek ? {...row, ...patch} : row)));
  }

  function practitionerName(staffId: string | undefined): string {
    if (!staffId) return "Whole clinic";
    return practitioners.find((p) => p.staffId === staffId)?.name ?? "Unknown practitioner";
  }

  async function saveSettings() {
    if (!timezone) {
      snackbar.show("Choose a timezone before saving", "danger");
      return;
    }
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
          // WP4.7A ruling R2 - omitted entirely for a non-owner, not merely left at its current
          // value: the route rejects the field's mere PRESENCE from anyone but an owner, so
          // sending it unchanged would still 403 and block this save of every other field too.
          ...(isOwner ? {schedulingMode} : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      // WP4.7 D1 - the server's rejection (no bookable practitioner with their own hours yet) is
      // specific and actionable; surface it verbatim rather than a generic failure message so the
      // owner sees exactly what to do next instead of just "try again".
      if (!res.ok) throw new Error(body?.error?.message ?? "Save failed");
      snackbar.show("Booking settings saved", "ok");
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Could not save booking settings - try again", "danger");
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
                // A practitioner's own capacity is always 1 (D2/A4 - the engine forces this
                // regardless of what's stored), so a scoped save never sends the clinic-wide row's
                // capacity input value, which is hidden for exactly this reason.
                capacity: selectedPractitionerId ? 1 : r.capacity,
                ...(selectedPractitionerId ? {staffId: selectedPractitionerId} : {}),
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
      body: JSON.stringify({
        date: newExceptionDate,
        closed: true,
        ...(newExceptionStaffId ? {staffId: newExceptionStaffId} : {}),
      }),
    });
    if (res.ok) {
      const created = await res.json();
      setExceptionList((prev) => [...prev, created].sort((a, b) => a.date.localeCompare(b.date)));
      setNewExceptionDate("");
      snackbar.show("Closure added", "ok");
    } else {
      const body = await res.json().catch(() => null);
      snackbar.show(body?.error?.message ?? "Could not add closure", "danger");
    }
  }

  async function removeException(exceptionId: string) {
    const res = await fetch(`/api/availability/exceptions/${exceptionId}`, {method: "DELETE"});
    if (res.ok) setExceptionList((prev) => prev.filter((e) => e.exceptionId !== exceptionId));
  }

  return (
    <>
      <FormSection title="Booking configuration" helperText="Governs the public booking page and the availability engine.">
        <FormField
          label="Scheduling mode"
          htmlFor="scheduling-mode"
          helperText={
            isOwner
              ? '"Per practitioner" needs at least one vet or owner marked bookable below, with their own weekly hours set in the picker underneath "Weekly hours".'
              : "Only an owner can change the scheduling mode - ask an owner to switch this setting."
          }
        >
          <Select
            id="scheduling-mode"
            value={schedulingMode}
            onChange={(e) => setSchedulingMode(e.target.value as SchedulingMode)}
            disabled={!isOwner}
          >
            <option value="clinic">Whole clinic</option>
            <option value="practitioner">Per practitioner</option>
          </Select>
        </FormField>
        <FormField
          label="Timezone"
          htmlFor="booking-timezone"
          helperText="Search the clinic's IANA timezone by city or region, e.g. New York."
        >
          <TimezonePicker id="booking-timezone" ariaLabel="Timezone" value={timezone} onChange={setTimezone} />
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

      <FormSection
        title={selectedPractitionerId ? `Weekly hours - ${practitionerName(selectedPractitionerId)}` : "Weekly hours - whole clinic"}
        helperText="One open window per day; use exceptions below for holidays or one-off changes."
      >
        <FormField
          label="Practitioner"
          htmlFor="hours-scope"
          helperText="Choose whose weekly hours to view and edit below. Available regardless of the current scheduling mode, so you can set a practitioner's hours before switching to per-practitioner scheduling."
        >
          <Select id="hours-scope" value={selectedPractitionerId} onChange={(e) => setSelectedPractitionerId(e.target.value)}>
            <option value={CLINIC_WIDE}>Whole clinic</option>
            {practitioners.map((p) => (
              <option key={p.staffId} value={p.staffId}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormField>
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
                  {selectedPractitionerId ? (
                    <span className="text-caption text-ink-faint">One appointment at a time (per practitioner)</span>
                  ) : (
                    <>
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

      <FormSection title="Closures" helperText="Dates that are fully closed, overriding the weekly hours. Scope to one practitioner, or leave as Whole clinic to close for everyone.">
        <ul className="space-y-1">
          {exceptionList.map((exception) => (
            <li key={exception.exceptionId} className="flex items-center justify-between text-body text-ink">
              <span>
                {exception.date}
                <span className="ml-2 text-caption text-ink-faint">{practitionerName(exception.staffId)}</span>
              </span>
              <Button variant="ghost" onClick={() => removeException(exception.exceptionId)}>
                Remove
              </Button>
            </li>
          ))}
          {exceptionList.length === 0 && <li className="text-body text-ink-faint">No closures added.</li>}
        </ul>
        <div className="flex items-center gap-2">
          <Input type="date" value={newExceptionDate} onChange={(e) => setNewExceptionDate(e.target.value)} className="min-w-0 flex-1" />
          <Select
            value={newExceptionStaffId}
            onChange={(e) => setNewExceptionStaffId(e.target.value)}
            aria-label="Closure scope"
            className="w-40 shrink-0"
          >
            <option value={CLINIC_WIDE}>Whole clinic</option>
            {practitioners.map((p) => (
              <option key={p.staffId} value={p.staffId}>
                {p.name}
              </option>
            ))}
          </Select>
          <Button variant="secondary" className="shrink-0" onClick={addException}>
            Add closure
          </Button>
        </div>
      </FormSection>
    </>
  );
}
