"use client";

import {useState} from "react";
import {useRouter} from "next/navigation";
import {Button, Input, Textarea} from "@/components/ui/controls";
import {FormActionBar, FormField, FormSection} from "@/components/ui/FormSection";
import {useSnackbar} from "@/components/ui/Snackbar";
import type {ServiceDoc} from "@/lib/models/Service";

interface ServiceFormValues {
  name: string;
  description: string;
  durationMinutes: string;
  bufferBeforeMin: string;
  bufferAfterMin: string;
  priceAmount: string;
  priceCurrency: string;
  active: boolean;
  bookableOnline: boolean;
}

function toValues(service?: ServiceDoc): ServiceFormValues {
  return {
    name: service?.name ?? "",
    description: service?.description ?? "",
    durationMinutes: String(service?.durationMinutes ?? 30),
    bufferBeforeMin: String(service?.bufferBeforeMin ?? 0),
    bufferAfterMin: String(service?.bufferAfterMin ?? 0),
    priceAmount: service?.price?.amount ?? "",
    priceCurrency: service?.price?.currency ?? "USD",
    active: service?.active ?? true,
    bookableOnline: service?.bookableOnline ?? false,
  };
}

type FieldErrors = Partial<Record<string, string>>;

/** The API's 400 shape: error.details is a zod flatten() - fieldErrors keyed by payload field
 * (same surfacing pattern as ClientForm; a blank-looking price row once produced only
 * "Could not save service - try again" while the server had said exactly what was wrong). */
function parseFieldErrors(body: unknown): {message?: string; fields: FieldErrors} {
  const error = (body as {error?: {message?: string; details?: {fieldErrors?: Record<string, string[]>}}} | null)?.error;
  const fields: FieldErrors = {};
  for (const [key, messages] of Object.entries(error?.details?.fieldErrors ?? {})) {
    if (messages?.[0]) fields[key] = messages[0];
  }
  return {message: error?.message, fields};
}

export function ServiceForm({service}: {service?: ServiceDoc}) {
  const router = useRouter();
  const snackbar = useSnackbar();
  const [values, setValues] = useState<ServiceFormValues>(toValues(service));
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  function set<K extends keyof ServiceFormValues>(key: K, value: ServiceFormValues[K]) {
    setValues((prev) => ({...prev, [key]: value}));
    // Editing the price inputs retires a stale "price" error; other fields map by name.
    const errorKey = key === "priceAmount" || key === "priceCurrency" ? "price" : key;
    setFieldErrors((prev) => (prev[errorKey] ? {...prev, [errorKey]: undefined} : prev));
  }

  async function handleSave() {
    if (!values.name.trim()) {
      setFieldErrors({name: "Name is required"});
      snackbar.show("Name is required", "danger");
      return;
    }
    setSaving(true);
    setFieldErrors({});
    const payload = {
      name: values.name.trim(),
      description: values.description.trim() || undefined,
      durationMinutes: Number(values.durationMinutes),
      bufferBeforeMin: Number(values.bufferBeforeMin),
      bufferAfterMin: Number(values.bufferAfterMin),
      price: values.priceAmount.trim() ? {amount: values.priceAmount.trim(), currency: values.priceCurrency} : undefined,
      active: values.active,
      bookableOnline: values.bookableOnline,
    };
    try {
      const res = await fetch(service ? `/api/services/${service.serviceId}` : "/api/services", {
        method: service ? "PATCH" : "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const {message, fields} = parseFieldErrors(await res.json().catch(() => null));
        setFieldErrors(fields);
        const firstField = Object.entries(fields).find((entry): entry is [string, string] => Boolean(entry[1]));
        snackbar.show(
          firstField
            ? `${firstField[0].charAt(0).toUpperCase()}${firstField[0].slice(1)}: ${firstField[1]}`
            : (message ?? "Could not save service - try again"),
          "danger",
        );
        return;
      }
      const saved = await res.json();
      snackbar.show(service ? "Service updated" : "Service created", "ok");
      if (!service) router.push(`/services/${saved.serviceId}`);
      else router.refresh();
    } catch {
      snackbar.show("Could not save service - try again", "danger");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <FormSection title="Details">
        <FormField label="Name" htmlFor="service-name" error={fieldErrors.name}>
          <Input id="service-name" value={values.name} onChange={(e) => set("name", e.target.value)} required />
        </FormField>
        <FormField label="Description" htmlFor="service-description">
          <Textarea
            id="service-description"
            rows={3}
            value={values.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </FormField>
        <FormField label="Duration (minutes)" htmlFor="service-duration" error={fieldErrors.durationMinutes}>
          <Input
            id="service-duration"
            type="number"
            min={1}
            value={values.durationMinutes}
            onChange={(e) => set("durationMinutes", e.target.value)}
          />
        </FormField>
        <FormField label="Buffer before (minutes)" htmlFor="service-buffer-before">
          <Input
            id="service-buffer-before"
            type="number"
            min={0}
            value={values.bufferBeforeMin}
            onChange={(e) => set("bufferBeforeMin", e.target.value)}
          />
        </FormField>
        <FormField label="Buffer after (minutes)" htmlFor="service-buffer-after">
          <Input
            id="service-buffer-after"
            type="number"
            min={0}
            value={values.bufferAfterMin}
            onChange={(e) => set("bufferAfterMin", e.target.value)}
          />
        </FormField>
        <FormField
          label="Price"
          htmlFor="service-price"
          error={fieldErrors.price}
          helperText="Amount first (e.g. 45.00), currency code second. Leave the amount blank for no listed price."
        >
          {/* Widths live on wrappers: Input's base class is w-full, which fights flex-1/w-20
              overrides inside a flex row (the amount box once collapsed to a sliver while the
              currency box grew - the two were easy to mix up, and a save failed over it). */}
          <div className="flex gap-2">
            <div className="flex-1">
              <Input
                id="service-price"
                inputMode="decimal"
                value={values.priceAmount}
                onChange={(e) => set("priceAmount", e.target.value)}
                placeholder="45.00"
              />
            </div>
            <div className="w-24 shrink-0">
              <Input
                value={values.priceCurrency}
                onChange={(e) => set("priceCurrency", e.target.value.toUpperCase())}
                maxLength={3}
                aria-label="Currency"
              />
            </div>
          </div>
        </FormField>
        <FormField label="Active" htmlFor="service-active">
          <label className="flex items-center gap-2 text-body text-ink">
            <input
              id="service-active"
              type="checkbox"
              checked={values.active}
              onChange={(e) => set("active", e.target.checked)}
            />
            Shown in the clinic&apos;s own scheduling
          </label>
        </FormField>
        <FormField
          label="Bookable online"
          htmlFor="service-bookable"
          helperText="Off by default - staff scheduling only."
        >
          <label className="flex items-center gap-2 text-body text-ink">
            <input
              id="service-bookable"
              type="checkbox"
              checked={values.bookableOnline}
              onChange={(e) => set("bookableOnline", e.target.checked)}
            />
            Offered on the public booking page
          </label>
        </FormField>
      </FormSection>
      <FormActionBar>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : service ? "Save changes" : "Create service"}
        </Button>
      </FormActionBar>
    </div>
  );
}
