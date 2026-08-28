"use client";

import {useMemo, useState} from "react";
import {Button, Input, Select, Textarea} from "@/components/ui/controls";
import {FormField} from "@/components/ui/FormSection";
import {addCalendarDays, localDateMinuteToUtcSeconds, todayInTimeZone} from "@/lib/booking/dst";
import {formatUnixSeconds} from "@/lib/format";
import type {Money} from "@/lib/models/Service";

export interface BookableService {
  id: string;
  name: string;
  description?: string;
  durationMinutes: number;
  price?: Money;
}

interface Slot {
  startAt: string; // ISO instant, as returned by GET /v1/booking/availability
  endAt: string;
}

type Step = "pick" | "details" | "done";

/**
 * The interactive half of `/book`: pick a service, pick a date, pick an open slot, then hand over
 * contact details. Availability is fetched only on an explicit service/date change (never in a
 * render loop) since `GET /v1/booking/availability` is rate-limited to 60/min and
 * `POST /v1/booking/book` to 10/min per `vet-public-api.yaml` - a page that re-fetched on every
 * keystroke or re-render would burn through either budget for no reason.
 */
export function BookingWizard({
  services,
  timeZone,
  minNoticeMinutes,
  maxAdvanceDays,
}: {
  services: BookableService[];
  timeZone: string;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
}) {
  const [step, setStep] = useState<Step>("pick");
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const today = useMemo(() => todayInTimeZone(timeZone), [timeZone]);
  const maxDate = useMemo(() => addCalendarDays(today, maxAdvanceDays), [today, maxAdvanceDays]);
  const [dateStr, setDateStr] = useState(today);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [petName, setPetName] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedService = services.find((s) => s.id === serviceId);

  async function loadSlots() {
    if (!serviceId) return;
    setLoadingSlots(true);
    setError(null);
    setSelectedSlot(null);
    try {
      const fromUtc = localDateMinuteToUtcSeconds(dateStr, 0, timeZone);
      const nextDay = addCalendarDays(dateStr, 1);
      const toUtc = localDateMinuteToUtcSeconds(nextDay, 0, timeZone);
      if (fromUtc === null || toUtc === null) {
        setSlots([]);
        return;
      }
      const params = new URLSearchParams({
        serviceId,
        from: new Date(fromUtc * 1000).toISOString(),
        to: new Date(toUtc * 1000).toISOString(),
      });
      const res = await fetch(`/v1/booking/availability?${params.toString()}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not load availability.");
      setSlots(body.slots ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load availability.");
      setSlots([]);
    } finally {
      setLoadingSlots(false);
    }
  }

  async function submitBooking() {
    if (!selectedSlot || !selectedService) return;
    if (!name.trim() || !email.trim()) {
      setError("Name and email are required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/v1/booking/book", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          serviceId: selectedService.id,
          startAt: selectedSlot.startAt,
          client: {name: name.trim(), email: email.trim(), phone: phone.trim() || undefined},
          petName: petName.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not book this time - please try another.");
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not book this time - please try another.");
    } finally {
      setSubmitting(false);
    }
  }

  if (services.length === 0) {
    return <p className="text-body text-ink-muted">This clinic is not accepting online bookings right now.</p>;
  }

  if (step === "done") {
    return (
      <div className="rounded-card border border-ok/30 bg-ok-soft p-5">
        <p className="text-emphasized font-semibold text-ok">Appointment booked</p>
        <p className="mt-1 text-body text-ink">
          A confirmation email is on its way to {email.trim()}, with a link to manage or cancel this appointment.
        </p>
      </div>
    );
  }

  if (step === "details" && selectedSlot && selectedService) {
    return (
      <div className="space-y-4 rounded-card border border-border bg-surface p-5 shadow-card">
        <div>
          <p className="text-caption uppercase tracking-wide text-ink-muted">Confirming</p>
          <p className="mt-1 text-emphasized text-ink">{selectedService.name}</p>
          <p className="text-body text-ink-muted">{formatUnixSeconds(Math.floor(new Date(selectedSlot.startAt).getTime() / 1000), timeZone, true)}</p>
        </div>

        <FormField label="Your name" htmlFor="book-name">
          <Input id="book-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </FormField>
        <FormField label="Email" htmlFor="book-email" helperText="Your confirmation and manage/cancel link go here.">
          <Input id="book-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </FormField>
        <FormField label="Phone" htmlFor="book-phone" helperText="Optional.">
          <Input id="book-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </FormField>
        <FormField label="Pet's name" htmlFor="book-pet" helperText="Optional.">
          <Input id="book-pet" value={petName} onChange={(e) => setPetName(e.target.value)} />
        </FormField>
        <FormField label="Notes for the clinic" htmlFor="book-notes" helperText="Optional.">
          <Textarea id="book-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </FormField>

        {error && <p className="text-body text-danger">{error}</p>}

        <div className="flex items-center gap-3">
          <Button variant="secondary" type="button" onClick={() => setStep("pick")} disabled={submitting}>
            Back
          </Button>
          <Button type="button" onClick={submitBooking} disabled={submitting}>
            {submitting ? "Booking..." : "Confirm booking"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-card border border-border bg-surface p-5 shadow-card">
      <FormField label="Service" htmlFor="book-service">
        <Select
          id="book-service"
          value={serviceId}
          onChange={(e) => {
            setServiceId(e.target.value);
            setSlots(null);
          }}
        >
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} - {s.durationMinutes} min{s.price ? ` - ${s.price.amount} ${s.price.currency}` : ""}
            </option>
          ))}
        </Select>
        {selectedService?.description && <p className="mt-1.5 text-caption text-ink-muted">{selectedService.description}</p>}
      </FormField>

      <FormField label="Date" htmlFor="book-date">
        <div className="flex items-center gap-2">
          <Input
            id="book-date"
            type="date"
            min={today}
            max={maxDate}
            value={dateStr}
            onChange={(e) => {
              setDateStr(e.target.value);
              setSlots(null);
            }}
          />
          <Button type="button" variant="secondary" onClick={loadSlots} disabled={loadingSlots || !serviceId}>
            {loadingSlots ? "Checking..." : "Check availability"}
          </Button>
        </div>
      </FormField>

      {error && <p className="text-body text-danger">{error}</p>}

      {slots !== null && (
        <div>
          <p className="mb-2 text-body font-medium text-ink">Open times</p>
          {slots.length === 0 ? (
            <p className="text-body text-ink-faint">No open times on this date - try another day.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {slots.map((slot) => (
                <button
                  key={slot.startAt}
                  type="button"
                  onClick={() => {
                    setSelectedSlot(slot);
                    setStep("details");
                  }}
                  className="rounded-control border border-border px-3 py-1.5 text-body text-ink hover:border-brand hover:bg-brand-soft hover:text-brand"
                >
                  {formatUnixSeconds(Math.floor(new Date(slot.startAt).getTime() / 1000), timeZone).split(", ").slice(1).join(", ")}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <p className="text-caption text-ink-faint">
        Bookings need at least {minNoticeMinutes} minutes&apos; notice and can be made up to {maxAdvanceDays} days ahead.
      </p>
    </div>
  );
}
