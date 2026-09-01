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
import type {ClientDoc} from "@/lib/models/Client";
import type {PetDoc} from "@/lib/models/Pet";

export interface CalendarAppointment {
  appointmentId: string;
  startAt: number;
  endAt: number;
  status: AppointmentStatus;
  clientName: string;
  petName: string;
  serviceId?: string;
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
}

const ROW_MINUTES = 30;
const ROW_HEIGHT_PX = 32;

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

export function CalendarView(props: CalendarViewProps) {
  const {dates, timezone, view, anchorDate, dayStartMinute, dayEndMinute, appointments, services, hasHoursOutsideRules} = props;
  const router = useRouter();
  const snackbar = useSnackbar();
  const [draft, setDraft] = useState<{date: string; minute: number} | null>(null);
  const [statusFilter, setStatusFilter] = useState<AppointmentStatus | "">("");

  const rows = useMemo(() => {
    const list: number[] = [];
    for (let m = dayStartMinute; m < dayEndMinute; m += ROW_MINUTES) list.push(m);
    return list;
  }, [dayStartMinute, dayEndMinute]);

  const appointmentsByDate = useMemo(() => {
    const map = new Map<string, (CalendarAppointment & {localMinute: number; durationMinutes: number})[]>();
    for (const apt of appointments) {
      if (statusFilter && apt.status !== statusFilter) continue;
      const {date, minuteOfDay} = localParts(apt.startAt, timezone);
      const durationMinutes = Math.round((apt.endAt - apt.startAt) / 60);
      const list = map.get(date) ?? [];
      list.push({...apt, localMinute: minuteOfDay, durationMinutes});
      map.set(date, list);
    }
    return map;
  }, [appointments, timezone, statusFilter]);

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
          style={{gridTemplateColumns: `64px repeat(${dates.length}, minmax(140px, 1fr))`}}
        >
          <div className="sticky top-0 z-10 border-b border-r border-border bg-surface-2" />
          {dates.map((d) => (
            <div
              key={d}
              className="sticky top-0 z-10 border-b border-l border-border bg-surface-2 px-2 py-2 text-center"
            >
              <div className="text-caption uppercase tracking-wide text-ink-muted">{weekdayLabel(d)}</div>
              <div className="text-body font-medium text-ink">{d.slice(5)}</div>
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
              {dates.map((d) => {
                const cellAppointments = (appointmentsByDate.get(d) ?? []).filter(
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
                    key={`${d}-${minute}`}
                    className="relative border-l border-t border-border"
                    style={{height: ROW_HEIGHT_PX}}
                  >
                    <button
                      type="button"
                      onClick={() => setDraft({date: d, minute})}
                      aria-label={`New appointment ${d} ${formatMinuteLabel(minute)}`}
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

const toneClasses = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  neutral: "bg-neutral-status-soft text-neutral-status",
} as const;

function CreateAppointmentPanel({
  date,
  minute,
  services,
  onClose,
  onCreated,
}: {
  date: string;
  minute: number;
  services: CalendarService[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [walkIn, setWalkIn] = useState(false);
  const [selectedClient, setSelectedClient] = useState<ClientDoc | null>(null);
  const [selectedPets, setSelectedPets] = useState<PetDoc[]>([]);
  const [clientName, setClientName] = useState("");
  const [petName, setPetName] = useState("");
  const [serviceId, setServiceId] = useState(services[0]?.serviceId ?? "");
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
