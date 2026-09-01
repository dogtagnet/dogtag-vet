"use client";

import {Fragment, useMemo, useState} from "react";
import Link from "next/link";
import {useRouter} from "next/navigation";
import {Banner} from "@/components/ui/Banner";
import {Button, Input, Select, Textarea} from "@/components/ui/controls";
import {useSnackbar} from "@/components/ui/Snackbar";
import {ClientPicker} from "@/components/pickers/ClientPicker";
import {PetMultiPicker} from "@/components/pickers/PetMultiPicker";
import {appointmentStatusLabel, appointmentStatusTone} from "@/lib/appointmentTone";
import type {AppointmentStatus} from "@/lib/models/Appointment";
import type {SchedulingMode} from "@/lib/models/Availability";
import type {ClientDoc} from "@/lib/models/Client";
import type {PetDoc} from "@/lib/models/Pet";
import type {PractitionerSummary} from "@/lib/booking/queries";

export interface CalendarAppointment {
  appointmentId: string;
  startAt: number;
  endAt: number;
  status: AppointmentStatus;
  clientName: string;
  petName: string;
  serviceId?: string;
  /** WP4.7 A4/A6 - see `AppointmentDoc.practitionerStaffId`'s own doc comment. Absent means
   * unassigned (D3) whenever `schedulingMode` is "practitioner"; simply unused in clinic mode. */
  practitionerStaffId?: string;
  /** WP4.7 A6 - the legacy free-text field, shown read-only on the detail page when set. Never
   * rendered here on the calendar grid itself (there is no room in a chip for it); carried through
   * so `AppointmentDetailPanel` doesn't need a second fetch just to display it. */
  staffName?: string;
}

export interface CalendarService {
  serviceId: string;
  name: string;
  durationMinutes: number;
}

export interface CalendarViewProps {
  dates: string[];
  timezone: string;
  view: "week" | "day";
  anchorDate: string;
  dayStartMinute: number;
  dayEndMinute: number;
  appointments: CalendarAppointment[];
  services: CalendarService[];
  /** True when the grid's window had to widen past the clinic's normal weekly hours to fit an
   * availability exception's extended window or an appointment actually booked outside them
   * (`computeCalendarWindow`, `src/lib/booking/calendarWindow.ts`) - shows a small banner so staff
   * understand why the grid runs earlier/later than the usual business hours, rather than the grid
   * silently stretching with no explanation. */
  hasHoursOutsideRules?: boolean;
  /** WP4.7 A6. Clinic mode's rendering below is completely unaffected by anything in this section -
   * no practitioner filter, no accent badges, no day-view columns - matching every other surface in
   * this WP that keeps clinic mode byte-identical to its pre-WP4.7 behavior. */
  schedulingMode: SchedulingMode;
  /** Every currently bookable practitioner, sorted by staffId (`listBookablePractitioners`'s own
   * sort) - the SAME order every other WP4.7 A6 surface uses, so a practitioner's accent color
   * (keyed by index into this list) never disagrees between the calendar, a chip, and anywhere
   * else it might be shown. */
  practitioners: PractitionerSummary[];
}

const ROW_MINUTES = 30;
const ROW_HEIGHT_PX = 32;

/** Sentinel for the practitioner filter's "Unassigned" option - a plain HTML `<select>` only
 * carries string values, and "" is already taken by "All practitioners" (matching this file's own
 * status filter's "" = "All statuses" convention). */
const UNASSIGNED_FILTER = "__unassigned__";

/** The 5-tone palette this app already uses for appointment status (`appointmentTone.ts`,
 * `StatusBadge`) - reused here as WP4.7 A6's practitioner accent palette rather than inventing a
 * second one, and specifically NOT a set of new hex values: every one of these classes resolves to
 * a `tailwind.config.ts` color token (that file's own doc comment: nothing in this app hardcodes a
 * color). Cycling through 5 tones for what could be any number of practitioners means two
 * practitioners can land on the same tone once a clinic has more than 5 bookable ones - acceptable
 * for a cosmetic scanning aid (the column header / Select already disambiguates who is who), not
 * worth a bespoke larger palette. */
const toneClasses = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  neutral: "bg-neutral-status-soft text-neutral-status",
} as const;
type Tone = keyof typeof toneClasses;
const ACCENT_TONES: Tone[] = ["ok", "warn", "danger", "info", "neutral"];

/** Deterministic accent tone for `staffId`, keyed by its index in `practitioners` AS PASSED IN
 * (callers pass the already-`listBookablePractitioners`-sorted list, never re-sorted here, so
 * every caller on the page agrees on who gets which color). `undefined`/unassigned and an unknown
 * staffId both fall back to "neutral" - the same tone the Unassigned column itself uses. */
function practitionerAccentTone(practitioners: PractitionerSummary[], staffId: string | undefined): Tone {
  if (!staffId) return "neutral";
  const index = practitioners.findIndex((p) => p.staffId === staffId);
  return index === -1 ? "neutral" : (ACCENT_TONES[index % ACCENT_TONES.length] ?? "neutral");
}

/** "Dr. Jane Smith" -> "JS"; a single-word name (a bare email local-part fallback, e.g. "owner")
 * -> "OW". Initials read faster than a full name in a dense calendar cell (WP4.7 A6). */
function practitionerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return `${(parts[0] ?? "")[0] ?? ""}${(parts[parts.length - 1] ?? "")[0] ?? ""}`.toUpperCase();
}

/** Local (clinic-timezone, not browser-timezone) date string and minute-of-day for a UTC
 * unix-seconds instant, computed via `Intl.DateTimeFormat` so it is correct regardless of which
 * timezone the staff member's own browser happens to be in - a shared clinic calendar should show
 * the same wall-clock times to every viewer. */
function localParts(utcSeconds: number, timeZone: string): {date: string; minuteOfDay: number} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utcSeconds * 1000)).map((p) => [p.type, p.value]));
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  return {date: `${parts.year}-${parts.month}-${parts.day}`, minuteOfDay: hour * 60 + Number(parts.minute)};
}

function formatMinuteLabel(minuteOfDay: number): string {
  const hour24 = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const period = hour24 < 12 ? "AM" : "PM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return minute === 0 ? `${hour12} ${period}` : `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

/** Parses `"YYYY-MM-DD"` into numeric parts - a small local helper so every call site here gets
 * plain `number`s back instead of `number | undefined` from a bare `.split("-").map(Number)`. */
function parseIsoDate(dateStr: string): {year: number; month: number; day: number} {
  const parts = dateStr.split("-");
  return {year: Number(parts[0]), month: Number(parts[1]), day: Number(parts[2])};
}

function weekdayLabel(dateStr: string): string {
  const {year, month, day} = parseIsoDate(dateStr);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(undefined, {weekday: "short", timeZone: "UTC"});
}

type PositionedAppointment = CalendarAppointment & {localMinute: number; durationMinutes: number};

interface GridColumn {
  key: string;
  /** Which date a slot click in this column resolves to. */
  date: string;
  /** The practitioner a slot click in this column should pre-select - `undefined` for the
   * Unassigned column and for every column outside day-view-practitioner-columns mode. */
  practitionerStaffId?: string;
  headerPrimary: string;
  headerSecondary?: string;
  accentTone?: Tone;
  appointments: PositionedAppointment[];
}

export function CalendarView(props: CalendarViewProps) {
  const {
    dates,
    timezone,
    view,
    anchorDate,
    dayStartMinute,
    dayEndMinute,
    appointments,
    services,
    hasHoursOutsideRules,
    schedulingMode,
    practitioners,
  } = props;
  const router = useRouter();
  const snackbar = useSnackbar();
  const [draft, setDraft] = useState<{date: string; minute: number; practitionerStaffId?: string} | null>(null);
  const [statusFilter, setStatusFilter] = useState<AppointmentStatus | "">("");
  const [practitionerFilter, setPractitionerFilter] = useState("");

  const rows = useMemo(() => {
    const list: number[] = [];
    for (let m = dayStartMinute; m < dayEndMinute; m += ROW_MINUTES) list.push(m);
    return list;
  }, [dayStartMinute, dayEndMinute]);

  const appointmentsByDate = useMemo(() => {
    const map = new Map<string, PositionedAppointment[]>();
    for (const apt of appointments) {
      if (statusFilter && apt.status !== statusFilter) continue;
      if (practitionerFilter === UNASSIGNED_FILTER && apt.practitionerStaffId) continue;
      if (practitionerFilter && practitionerFilter !== UNASSIGNED_FILTER && apt.practitionerStaffId !== practitionerFilter) continue;
      const {date, minuteOfDay} = localParts(apt.startAt, timezone);
      const durationMinutes = Math.round((apt.endAt - apt.startAt) / 60);
      const list = map.get(date) ?? [];
      list.push({...apt, localMinute: minuteOfDay, durationMinutes});
      map.set(date, list);
    }
    return map;
  }, [appointments, timezone, statusFilter, practitionerFilter]);

  // WP4.7 A6 - DAY view's own columns become "one per bookable practitioner (+ Unassigned when it
  // has anything)" instead of "one per date" the moment practitioner scheduling is on. WEEK view,
  // and DAY view in clinic mode, keep exactly today's date-column layout - only the practitioner
  // filter above (already folded into appointmentsByDate) and each chip's accent badge below
  // change anything for them.
  const showPractitionerColumns = view === "day" && schedulingMode === "practitioner";

  const columns = useMemo<GridColumn[]>(() => {
    if (!showPractitionerColumns) {
      return dates.map((d) => ({
        key: d,
        date: d,
        headerPrimary: weekdayLabel(d),
        headerSecondary: d.slice(5),
        appointments: appointmentsByDate.get(d) ?? [],
      }));
    }

    const dayDate = dates[0] ?? anchorDate;
    const dayAppointments = appointmentsByDate.get(dayDate) ?? [];
    const relevantPractitioners =
      practitionerFilter && practitionerFilter !== UNASSIGNED_FILTER
        ? practitioners.filter((p) => p.staffId === practitionerFilter)
        : practitioners;
    const cols: GridColumn[] = relevantPractitioners.map((p) => ({
      key: p.staffId,
      date: dayDate,
      practitionerStaffId: p.staffId,
      headerPrimary: p.name,
      headerSecondary: practitionerInitials(p.name),
      accentTone: practitionerAccentTone(practitioners, p.staffId),
      appointments: dayAppointments.filter((a) => a.practitionerStaffId === p.staffId),
    }));

    const unassigned = dayAppointments.filter((a) => !a.practitionerStaffId);
    if (practitionerFilter === UNASSIGNED_FILTER || (practitionerFilter === "" && unassigned.length > 0)) {
      cols.push({
        key: "unassigned",
        date: dayDate,
        practitionerStaffId: undefined,
        headerPrimary: "Unassigned",
        accentTone: "neutral",
        appointments: unassigned,
      });
    }
    return cols;
  }, [showPractitionerColumns, dates, anchorDate, appointmentsByDate, practitionerFilter, practitioners]);

  function navigate(nextDate: string, nextView: "week" | "day" = view) {
    router.push(`/calendar?date=${nextDate}&view=${nextView}`);
  }

  function shiftDate(days: number) {
    const {year, month, day} = parseIsoDate(anchorDate);
    const next = new Date(Date.UTC(year, month - 1, day + days));
    navigate(next.toISOString().slice(0, 10));
  }

  return (
    <div>
      {hasHoursOutsideRules && (
        <div className="mb-4">
          <Banner tone="info" title="Showing hours outside the normal schedule">
            This range includes an availability exception or a booked appointment outside the clinic&apos;s standard weekly hours, so the grid has widened to show it.
          </Banner>
        </div>
      )}
      {showPractitionerColumns && columns.length === 0 && (
        <div className="mb-4">
          <Banner tone="warn" title="No bookable practitioners">
            Mark at least one vet or owner bookable under Settings to see per-practitioner columns here.
          </Banner>
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => shiftDate(view === "day" ? -1 : -7)}>
            Previous
          </Button>
          <Button variant="secondary" onClick={() => navigate(anchorDate)}>
            Today
          </Button>
          <Button variant="secondary" onClick={() => shiftDate(view === "day" ? 1 : 7)}>
            Next
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as AppointmentStatus | "")}
            className="w-auto"
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {(Object.keys(appointmentStatusLabel) as AppointmentStatus[]).map((status) => (
              <option key={status} value={status}>
                {appointmentStatusLabel[status]}
              </option>
            ))}
          </Select>
          {schedulingMode === "practitioner" && (
            <Select
              value={practitionerFilter}
              onChange={(e) => setPractitionerFilter(e.target.value)}
              className="w-auto"
              aria-label="Filter by practitioner"
            >
              <option value="">All practitioners</option>
              {practitioners.map((p) => (
                <option key={p.staffId} value={p.staffId}>
                  {p.name}
                </option>
              ))}
              <option value={UNASSIGNED_FILTER}>Unassigned</option>
            </Select>
          )}
          <div className="inline-flex rounded-control border border-border">
            <button
              type="button"
              onClick={() => navigate(anchorDate, "week")}
              className={`px-3 py-1.5 text-body ${view === "week" ? "bg-brand text-white" : "text-ink hover:bg-surface-2"}`}
            >
              Week
            </button>
            <button
              type="button"
              onClick={() => navigate(anchorDate, "day")}
              className={`px-3 py-1.5 text-body ${view === "day" ? "bg-brand text-white" : "text-ink hover:bg-surface-2"}`}
            >
              Day
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
        <div
          className="grid"
          style={{gridTemplateColumns: `64px repeat(${Math.max(columns.length, 1)}, minmax(140px, 1fr))`}}
        >
          <div className="sticky top-0 z-10 border-b border-r border-border bg-surface-2" />
          {columns.map((col) => (
            <div
              key={col.key}
              className="sticky top-0 z-10 border-b border-l border-border bg-surface-2 px-2 py-2 text-center"
            >
              {col.accentTone ? (
                <div className="flex items-center justify-center gap-1.5">
                  <span
                    className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-badge text-[10px] font-medium ${toneClasses[col.accentTone]}`}
                  >
                    {col.headerSecondary}
                  </span>
                  <span className="truncate text-body font-medium text-ink">{col.headerPrimary}</span>
                </div>
              ) : (
                <>
                  <div className="text-caption uppercase tracking-wide text-ink-muted">{col.headerPrimary}</div>
                  <div className="text-body font-medium text-ink">{col.headerSecondary}</div>
                </>
              )}
            </div>
          ))}

          {rows.map((minute) => (
            <Fragment key={minute}>
              <div
                className="border-r border-t border-border px-2 py-1 text-right text-caption text-ink-faint"
                style={{height: ROW_HEIGHT_PX}}
              >
                {minute % 60 === 0 ? formatMinuteLabel(minute) : ""}
              </div>
              {columns.map((col) => {
                const cellAppointments = col.appointments.filter(
                  (a) => a.localMinute >= minute && a.localMinute < minute + ROW_MINUTES,
                );
                return (
                  // The slot's create-draft button and each appointment chip are SIBLINGS here,
                  // never nested - previously the chips were plain <div>s absolutely positioned
                  // INSIDE the slot <button>, so clicking an existing appointment always also
                  // opened the New-appointment dialog (the click bubbled up into the button it was
                  // visually stacked on top of - WP4.3 C7's bug). Each chip is now its own <button>
                  // stacked on top (z-10) via CSS, not the DOM, so its click can never reach the
                  // slot button underneath - stopPropagation() below is defense in depth for that,
                  // not what actually fixes it.
                  <div
                    key={`${col.key}-${minute}`}
                    className="relative border-l border-t border-border"
                    style={{height: ROW_HEIGHT_PX}}
                  >
                    <button
                      type="button"
                      onClick={() => setDraft({date: col.date, minute, practitionerStaffId: col.practitionerStaffId})}
                      aria-label={`New appointment ${col.date} ${formatMinuteLabel(minute)}${col.practitionerStaffId ? ` with ${col.headerPrimary}` : ""}`}
                      className="absolute inset-0 text-left hover:bg-surface-2"
                    />
                    {cellAppointments.map((a) => (
                      <button
                        key={a.appointmentId}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(`/appointments/${a.appointmentId}`);
                        }}
                        aria-label={`${a.clientName} - ${a.petName}, ${appointmentStatusLabel[a.status]}, view appointment`}
                        className="absolute inset-x-0.5 top-0.5 z-10 truncate rounded-control px-1.5 py-0.5 text-left text-caption"
                        style={{
                          height: Math.max(ROW_HEIGHT_PX - 4, (a.durationMinutes / ROW_MINUTES) * ROW_HEIGHT_PX - 4),
                        }}
                        data-tone={appointmentStatusTone[a.status]}
                      >
                        <ToneBox tone={appointmentStatusTone[a.status]}>
                          {schedulingMode === "practitioner" && (
                            <span
                              className={`mr-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-badge align-middle text-[8px] font-semibold ${toneClasses[practitionerAccentTone(practitioners, a.practitionerStaffId)]}`}
                            >
                              {a.practitionerStaffId
                                ? practitionerInitials(practitioners.find((p) => p.staffId === a.practitionerStaffId)?.name ?? "?")
                                : "?"}
                            </span>
                          )}
                          {a.clientName} - {a.petName}
                        </ToneBox>
                      </button>
                    ))}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>

      {draft && (
        <CreateAppointmentPanel
          date={draft.date}
          minute={draft.minute}
          services={services}
          schedulingMode={schedulingMode}
          practitioners={practitioners}
          initialPractitionerStaffId={draft.practitionerStaffId}
          onClose={() => setDraft(null)}
          onCreated={() => {
            setDraft(null);
            router.refresh();
            snackbar.show("Appointment created", "ok");
          }}
        />
      )}
    </div>
  );
}

function ToneBox({tone, children}: {tone: keyof typeof toneClasses; children: React.ReactNode}) {
  return <div className={`h-full w-full truncate rounded-control px-1 ${toneClasses[tone]}`}>{children}</div>;
}

function CreateAppointmentPanel({
  date,
  minute,
  services,
  schedulingMode,
  practitioners,
  initialPractitionerStaffId,
  onClose,
  onCreated,
}: {
  date: string;
  minute: number;
  services: CalendarService[];
  schedulingMode: SchedulingMode;
  practitioners: PractitionerSummary[];
  initialPractitionerStaffId?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [walkIn, setWalkIn] = useState(false);
  const [selectedClient, setSelectedClient] = useState<ClientDoc | null>(null);
  const [selectedPets, setSelectedPets] = useState<PetDoc[]>([]);
  const [clientName, setClientName] = useState("");
  const [petName, setPetName] = useState("");
  const [serviceId, setServiceId] = useState(services[0]?.serviceId ?? "");
  const [practitionerStaffId, setPractitionerStaffId] = useState(initialPractitionerStaffId ?? "");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const snackbar = useSnackbar();

  const service = services.find((s) => s.serviceId === serviceId);
  const durationMinutes = service?.durationMinutes ?? 30;

  async function handleCreate() {
    if (walkIn) {
      if (!clientName.trim() || !petName.trim()) {
        snackbar.show("Client and pet name are required", "danger");
        return;
      }
    } else {
      if (!selectedClient) {
        snackbar.show("Select a client, or switch to walk-in", "danger");
        return;
      }
      if (selectedPets.length === 0) {
        snackbar.show("Select at least one pet", "danger");
        return;
      }
    }
    setSaving(true);
    // Build the local wall-clock instant as an ISO string with no offset and let the server
    // resolve it in the clinic's own timezone (the same DST-safe path booking uses) - simpler
    // than duplicating that conversion in the browser.
    const {year, month, day} = parseIsoDate(date);
    const hour = Math.floor(minute / 60);
    const min = minute % 60;
    const localIso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
    try {
      const res = await fetch("/api/appointments/from-local-time", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          localIso,
          durationMinutes,
          serviceId: serviceId || undefined,
          notes,
          practitionerId: practitionerStaffId || undefined,
          ...(walkIn
            ? {clientName, petName}
            : {clientId: selectedClient!.clientId, petIds: selectedPets.map((p) => p.petId)}),
        }),
      });
      if (!res.ok) throw new Error("Create failed");
      onCreated();
    } catch {
      snackbar.show("Could not create appointment - try again", "danger");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-card border border-border bg-surface p-5 shadow-raised">
        <h3 className="mb-1 text-section-title text-ink">New appointment</h3>
        <p className="mb-4 text-body text-ink-muted">
          {date} at {formatMinuteLabel(minute)}
        </p>
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-body text-ink">
            <input
              type="checkbox"
              checked={walkIn}
              onChange={(e) => {
                setWalkIn(e.target.checked);
                setSelectedClient(null);
                setSelectedPets([]);
              }}
            />
            Walk-in (no client record)
          </label>
          {walkIn ? (
            <>
              <Input placeholder="Client name" value={clientName} onChange={(e) => setClientName(e.target.value)} />
              <Input placeholder="Pet name" value={petName} onChange={(e) => setPetName(e.target.value)} />
            </>
          ) : (
            <>
              <ClientPicker value={selectedClient} onChange={setSelectedClient} />
              <PetMultiPicker clientId={selectedClient?.clientId} value={selectedPets} onChange={setSelectedPets} />
            </>
          )}
          <Select aria-label="Service" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">No specific service</option>
            {services.map((s) => (
              <option key={s.serviceId} value={s.serviceId}>
                {s.name} ({s.durationMinutes} min)
              </option>
            ))}
          </Select>
          {services.length === 0 && (
            // Root cause of the "dropdown looks broken" report: zero services in the DB leaves
            // only the "No specific service" option, with no affordance telling staff where
            // services come from. Serviceless appointments stay legitimate (from-local-time's
            // serviceId is optional) - this is purely a discoverability hint, never a requirement.
            <p className="text-caption text-ink-faint">
              No active services yet.{" "}
              <Link href="/services/new" className="text-link hover:underline">
                Create one under Services
              </Link>{" "}
              to pick it here.
            </p>
          )}
          {schedulingMode === "practitioner" && (
            <Select aria-label="Practitioner" value={practitionerStaffId} onChange={(e) => setPractitionerStaffId(e.target.value)}>
              <option value="">Unassigned (auto-assign not used for staff bookings)</option>
              {practitioners.map((p) => (
                <option key={p.staffId} value={p.staffId}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
          <Textarea placeholder="Notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={saving}>
            {saving ? "Creating..." : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}
