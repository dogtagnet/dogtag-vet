"use client";

import {useState} from "react";
import Link from "next/link";
import {useRouter} from "next/navigation";
import {Button, Textarea} from "@/components/ui/controls";
import {FormSection} from "@/components/ui/FormSection";
import {KeyValuePanel, type KeyValueRow} from "@/components/ui/KeyValuePanel";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {useSnackbar} from "@/components/ui/Snackbar";
import {ClientPicker} from "@/components/pickers/ClientPicker";
import {PetMultiPicker} from "@/components/pickers/PetMultiPicker";
import {formatUnixSeconds} from "@/lib/format";
import {appointmentStatusLabel, appointmentStatusTone} from "@/lib/appointmentTone";
import {availableStatusActions} from "@/lib/booking/appointmentStatusGuard";
import type {AppointmentDoc, AppointmentStatus} from "@/lib/models/Appointment";
import type {ClientDoc} from "@/lib/models/Client";
import type {PetDoc} from "@/lib/models/Pet";

interface PatchBody {
  status?: AppointmentStatus;
  clientId?: string | null;
  petIds?: string[];
  notes?: string;
}

async function patchAppointment(appointmentId: string, body: PatchBody): Promise<{ok: boolean; message?: string}> {
  const res = await fetch(`/api/appointments/${appointmentId}`, {
    method: "PATCH",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
  });
  if (res.ok) return {ok: true};
  const parsed = await res.json().catch(() => null);
  return {ok: false, message: parsed?.error?.message ?? "Could not save this appointment - try again"};
}

function StatusActions({appointmentId, status, onSaved}: {appointmentId: string; status: AppointmentStatus; onSaved: () => void}) {
  const [busy, setBusy] = useState<string | null>(null);
  const snackbar = useSnackbar();
  const actions = availableStatusActions(status);

  if (actions.length === 0) return null;

  async function run(action: (typeof actions)[number]) {
    setBusy(action.action);
    const result = await patchAppointment(appointmentId, {status: action.to});
    setBusy(null);
    if (!result.ok) {
      snackbar.show(result.message ?? "Could not update status", "danger");
      return;
    }
    snackbar.show(`Appointment ${appointmentStatusLabel[action.to].toLowerCase()}`, "ok");
    onSaved();
  }

  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => (
        <Button
          key={action.action}
          variant={action.action === "cancel" || action.action === "no_show" ? "danger" : "secondary"}
          size="sm"
          disabled={busy !== null}
          onClick={() => run(action)}
        >
          {busy === action.action ? "Saving..." : action.label}
        </Button>
      ))}
    </div>
  );
}

function NotesSection({appointmentId, notes, onSaved}: {appointmentId: string; notes?: string; onSaved: () => void}) {
  const [value, setValue] = useState(notes ?? "");
  const [saving, setSaving] = useState(false);
  const snackbar = useSnackbar();

  async function handleSave() {
    setSaving(true);
    const result = await patchAppointment(appointmentId, {notes: value.trim()});
    setSaving(false);
    if (!result.ok) {
      snackbar.show(result.message ?? "Could not save notes", "danger");
      return;
    }
    snackbar.show("Notes saved", "ok");
    onSaved();
  }

  return (
    <FormSection title="Notes">
      <Textarea rows={3} value={value} onChange={(e) => setValue(e.target.value)} placeholder="No notes yet" />
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save notes"}
        </Button>
      </div>
    </FormSection>
  );
}

/**
 * Edit-tagging pickers, keyed by the server's CURRENT tagging truth (client id + sorted pet ids) -
 * remounting (and so resetting local picker state) only when that truth actually changes, e.g.
 * right after this section's own save round-trips through `router.refresh()`. An unrelated save
 * elsewhere on the page (a status action, notes) leaves the key untouched, so it never clobbers an
 * in-progress edit here.
 */
function EditTaggingSection({
  appointmentId,
  initialClient,
  initialPets,
  onSaved,
}: {
  appointmentId: string;
  initialClient: ClientDoc | null;
  initialPets: PetDoc[];
  onSaved: () => void;
}) {
  const [selectedClient, setSelectedClient] = useState<ClientDoc | null>(initialClient);
  const [selectedPets, setSelectedPets] = useState<PetDoc[]>(initialPets);
  const [saving, setSaving] = useState(false);
  const snackbar = useSnackbar();

  // A tagged client always needs at least one pet (WP4.3's symmetric tagging invariant -
  // appointmentTagging.ts's isTaggingConsistent); untagging (no client) always saves with an
  // empty petIds array in the SAME request, which is what makes a full untag internally
  // consistent rather than leaving stale pets pointing at a now-removed client.
  const canSave = selectedClient ? selectedPets.length > 0 : true;

  async function handleSave() {
    setSaving(true);
    const result = await patchAppointment(appointmentId, {
      clientId: selectedClient?.clientId ?? null,
      petIds: selectedPets.map((p) => p.petId),
    });
    setSaving(false);
    if (!result.ok) {
      snackbar.show(result.message ?? "Could not save tagging", "danger");
      return;
    }
    snackbar.show("Tagging saved", "ok");
    onSaved();
  }

  return (
    <FormSection title="Edit tagging" helperText="Retag this appointment to a different client and pets, or untag it entirely.">
      <ClientPicker value={selectedClient} onChange={setSelectedClient} />
      <PetMultiPicker clientId={selectedClient?.clientId} value={selectedPets} onChange={setSelectedPets} />
      {!canSave && (
        // Inline validation under the fields (design-system.md's FormSection idiom) - explains why
        // Save is disabled instead of leaving it as an unexplained dead end (WP4.3 round-1 fix):
        // this is most visible right after tagging a public-booking client, who has a client link
        // but no pets on file yet.
        <p className="mt-1 text-caption text-danger">Select at least one pet before saving - create one from the client page first if none exist yet.</p>
      )}
      <div className="flex justify-end">
        <Button size="sm" onClick={handleSave} disabled={saving || !canSave}>
          {saving ? "Saving..." : "Save tagging"}
        </Button>
      </div>
    </FormSection>
  );
}

export function AppointmentDetailPanel({
  appointment,
  client,
  pets,
  serviceName,
  timeZone,
}: {
  appointment: AppointmentDoc;
  client: ClientDoc | null;
  pets: PetDoc[];
  serviceName?: string;
  timeZone: string;
}) {
  const router = useRouter();

  function refresh() {
    router.refresh();
  }

  const durationMinutes = Math.round((appointment.endAt - appointment.startAt) / 60);
  const rows: KeyValueRow[] = [
    {key: "when", label: "When", value: formatUnixSeconds(appointment.startAt, timeZone)},
    {key: "duration", label: "Duration", value: `${durationMinutes} min`},
    {key: "service", label: "Service", value: serviceName ?? "No specific service"},
    {key: "source", label: "Source", value: appointment.source.replace("_", " ")},
    {
      key: "status",
      label: "Status",
      value: <StatusBadge tone={appointmentStatusTone[appointment.status]} label={appointmentStatusLabel[appointment.status]} />,
    },
  ];

  const taggingRows: KeyValueRow[] = [
    {
      key: "client",
      label: "Client",
      value: client ? (
        <Link href={`/clients/${client.clientId}`} className="text-link hover:underline">
          {client.name}
          {(client.email || client.phone) && (
            <span className="ml-2 text-caption text-ink-faint">{[client.email, client.phone].filter(Boolean).join(" · ")}</span>
          )}
        </Link>
      ) : (
        <span>
          {appointment.clientName} <span className="text-caption text-ink-faint">(walk-in - no client record)</span>
        </span>
      ),
    },
    {
      key: "pets",
      label: "Pets",
      value:
        pets.length > 0 ? (
          <span className="flex flex-wrap gap-x-2">
            {pets.map((pet, i) => (
              <span key={pet.petId}>
                <Link href={`/pets/${pet.petId}`} className="text-link hover:underline">
                  {pet.name}
                </Link>
                {i < pets.length - 1 ? "," : ""}
              </span>
            ))}
          </span>
        ) : (
          appointment.petName
        ),
    },
  ];

  return (
    <div className="max-w-2xl space-y-6">
      <KeyValuePanel title="Details" rows={rows} />
      <StatusActions appointmentId={appointment.appointmentId} status={appointment.status} onSaved={refresh} />
      <NotesSection appointmentId={appointment.appointmentId} notes={appointment.notes} onSaved={refresh} />
      <KeyValuePanel title="Tagged to" rows={taggingRows} />
      <EditTaggingSection
        key={`${client?.clientId ?? "none"}:${pets.map((p) => p.petId).sort().join(",")}`}
        appointmentId={appointment.appointmentId}
        initialClient={client}
        initialPets={pets}
        onSaved={refresh}
      />
    </div>
  );
}
