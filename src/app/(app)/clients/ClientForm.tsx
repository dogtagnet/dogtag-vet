"use client";

import {useState} from "react";
import {useRouter} from "next/navigation";
import {Button, Input, Textarea} from "@/components/ui/controls";
import {FormActionBar, FormField, FormSection} from "@/components/ui/FormSection";
import {useSnackbar} from "@/components/ui/Snackbar";
import type {ClientDoc} from "@/lib/models/Client";

export interface ClientFormValues {
  name: string;
  email: string;
  phone: string;
  address: string;
  notes: string;
}

function toValues(client?: ClientDoc): ClientFormValues {
  return {
    name: client?.name ?? "",
    email: client?.email ?? "",
    phone: client?.phone ?? "",
    address: client?.address ?? "",
    notes: client?.notes ?? "",
  };
}

export function ClientForm({client}: {client?: ClientDoc}) {
  const router = useRouter();
  const snackbar = useSnackbar();
  const [values, setValues] = useState<ClientFormValues>(toValues(client));
  const [saving, setSaving] = useState(false);

  function set<K extends keyof ClientFormValues>(key: K, value: ClientFormValues[K]) {
    setValues((prev) => ({...prev, [key]: value}));
  }

  async function handleSave() {
    if (!values.name.trim()) {
      snackbar.show("Name is required", "danger");
      return;
    }
    setSaving(true);
    const payload = {
      name: values.name.trim(),
      email: values.email.trim() || undefined,
      phone: values.phone.trim() || undefined,
      address: values.address.trim() || undefined,
      notes: values.notes.trim() || undefined,
    };
    try {
      const res = await fetch(client ? `/api/clients/${client.clientId}` : "/api/clients", {
        method: client ? "PATCH" : "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Save failed");
      const saved = await res.json();
      snackbar.show(client ? "Client updated" : "Client created", "ok");
      if (!client) router.push(`/clients/${saved.clientId}`);
      else router.refresh();
    } catch {
      snackbar.show("Could not save client - try again", "danger");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <FormSection title="Contact details">
        <FormField label="Name" htmlFor="client-name">
          <Input id="client-name" value={values.name} onChange={(e) => set("name", e.target.value)} required />
        </FormField>
        <FormField label="Email" htmlFor="client-email">
          <Input
            id="client-email"
            type="email"
            value={values.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </FormField>
        <FormField label="Phone" htmlFor="client-phone">
          <Input id="client-phone" value={values.phone} onChange={(e) => set("phone", e.target.value)} />
        </FormField>
        <FormField label="Address" htmlFor="client-address">
          <Input id="client-address" value={values.address} onChange={(e) => set("address", e.target.value)} />
        </FormField>
        <FormField label="Notes" htmlFor="client-notes">
          <Textarea
            id="client-notes"
            rows={3}
            value={values.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </FormField>
      </FormSection>
      <FormActionBar>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : client ? "Save changes" : "Create client"}
        </Button>
      </FormActionBar>
    </div>
  );
}
