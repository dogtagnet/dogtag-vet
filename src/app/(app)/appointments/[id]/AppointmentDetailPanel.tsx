"use client";

import {useEffect, useRef, useState} from "react";
import Link from "next/link";
import {useRouter} from "next/navigation";
import {AddressChip} from "@/components/ui/AddressChip";
import {Banner} from "@/components/ui/Banner";
import {Button, Textarea} from "@/components/ui/controls";
import {Combobox} from "@/components/pickers/Combobox";
import {FormSection} from "@/components/ui/FormSection";
import {KeyValuePanel, type KeyValueRow} from "@/components/ui/KeyValuePanel";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {useSnackbar} from "@/components/ui/Snackbar";
import {ClientPicker} from "@/components/pickers/ClientPicker";
import {PetMultiPicker} from "@/components/pickers/PetMultiPicker";
import {formatUnixSeconds} from "@/lib/format";
import {appointmentSourceLabel, appointmentStatusLabel, appointmentStatusTone} from "@/lib/appointmentTone";
import {availableStatusActions} from "@/lib/booking/appointmentStatusGuard";
import type {AppointmentDoc, AppointmentStatus, TagResolution} from "@/lib/models/Appointment";
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

/** Staff-facing label + assurance level per `TagResolution` - docs/mobile-booking.md's "Assurance
 * levels" table (Q4): appointment annotation is level 1 (asserted + chain-corroborated - ownership
 * NOT proven, level 3's consent-ZKP is a later upgrade); Q3's pet-record import (the "external" +
 * `dataVerified` case) is level 2 (a holder of the real profile data produced it). */
const tagResolutionLabel: Record<TagResolution, string> = {
  local: "Matched an existing pet on file",
  issued_here_unlinked: "Issued by this clinic, not linked to a pet record",
  external: "Issued by another clinic",
  unknown: "No tag found",
  none: "No tag claim",
};

/** Single-select pet search, scoped globally (not to one client) - `PetMultiPicker` is
 * client-scoped by design and wrong for this: the whole point of "issued_here_unlinked" is that no
 * local pet record is known to be linked to this claim at all, so staff must search every pet, not
 * one client's pets. Mirrors `ClientPicker`'s own debounced-global-search shape. */
function PetSearchPicker({onSelect}: {onSelect: (pet: PetDoc) => void}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PetDoc[]>([]);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(timeoutRef.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    timeoutRef.current = setTimeout(async () => {
      const res = await fetch(`/api/pets?q=${encodeURIComponent(query.trim())}`);
      if (res.ok) setResults(await res.json());
    }, 250);
    return () => clearTimeout(timeoutRef.current);
  }, [query]);

  return (
    <Combobox<PetDoc>
      ariaLabel="Search pets to relink"
      placeholder="Search pets by name"
      query={query}
      onQueryChange={setQuery}
      options={results}
      onSelect={(pet) => {
        onSelect(pet);
        setQuery("");
        setResults([]);
      }}
      getOptionKey={(pet) => pet.petId}
      renderOption={(pet) => (
        <div>
          <div className="font-medium text-ink">{pet.name}</div>
          {pet.species && <div className="text-caption text-ink-faint">{pet.species}</div>}
        </div>
      )}
      emptyHint="No matching pets"
    />
  );
}

/** Tier 3's one-click relink: staff picks the pet this clinic-issued (but locally unlinked) tag
 * actually belongs to - `POST /api/appointments/:id/relink-dogtag` re-verifies on chain before
 * writing (see that route's own doc comment) and, on success, tags this appointment to the chosen
 * pet directly. */
function RelinkDogTagAction({appointmentId, onSaved}: {appointmentId: string; onSaved: () => void}) {
  const [selectedPet, setSelectedPet] = useState<PetDoc | null>(null);
  const [saving, setSaving] = useState(false);
  const snackbar = useSnackbar();

  async function handleRelink() {
    if (!selectedPet) return;
    setSaving(true);
    const res = await fetch(`/api/appointments/${appointmentId}/relink-dogtag`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({petId: selectedPet.petId}),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      snackbar.show(body?.error?.message ?? "Could not relink this tag", "danger");
      return;
    }
    snackbar.show(`Tag relinked to ${selectedPet.name}`, "ok");
    setSelectedPet(null);
    onSaved();
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {selectedPet ? (
        <span className="inline-flex items-center gap-1.5 rounded-badge bg-brand-soft px-2.5 py-1 text-caption font-medium text-brand">
          {selectedPet.name}
          <button type="button" onClick={() => setSelectedPet(null)} aria-label={`Remove ${selectedPet.name}`} className="text-brand hover:opacity-70">
            x
          </button>
        </span>
      ) : (
        <div className="w-64">
          <PetSearchPicker onSelect={setSelectedPet} />
        </div>
      )}
      <Button size="sm" onClick={handleRelink} disabled={!selectedPet || saving}>
        {saving ? "Relinking..." : "Relink"}
      </Button>
    </div>
  );
}

/**
 * WP4.4's provenance box - `bookingIdentity`, only present on `source: "mobile"` appointments.
 * Renders the wallet claim (verified/unverified) and the tag-claim tier's resolved outcome, with
 * the staff action each tier calls for: tier 1's ownership-mismatch review flag, tier 3's relink,
 * tier 4's issuer/validity/import status.
 */
function ProvenanceBox({appointment, onSaved}: {appointment: AppointmentDoc; onSaved: () => void}) {
  const identity = appointment.bookingIdentity;
  if (!identity) return null;

  return (
    <section data-testid="provenance-box" className="rounded-card border border-border bg-surface p-5 shadow-card">
      <h3 className="mb-4 text-section-title text-ink">Provenance</h3>
      {/* Review finding 4: the booking itself durably succeeded, but its post-insert follow-up
       * writes (Q3's pet import/reuse, Q1's wallet auto-attach - lib/booking/postBooking.ts) did
       * not all complete - staff completes them by hand rather than the client being told their
       * confirmed booking "failed". */}
      {identity.postBookingIncomplete && (
        <div className="mb-4">
          <Banner tone="warn" title="This booking was created, but its follow-up records did not complete">
            <p>
              A pet import or wallet attachment failed after the appointment itself was booked. The
              client&apos;s booking and confirmation are fine - review this client&apos;s pets and wallets and
              complete anything missing by hand.
            </p>
          </Banner>
        </div>
      )}
      <dl className="grid grid-cols-1 gap-4">
        {identity.walletAddress && (
          <div>
            <dt className="text-caption text-ink-faint">Wallet</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <AddressChip address={identity.walletAddress} chain="roax" />
              <StatusBadge tone={identity.walletVerified ? "ok" : "danger"} label={identity.walletVerified ? "Verified" : "Unverified"} />
            </dd>
            {identity.walletMultiMatch && (
              /* Review finding 6: the same wallet on multiple client records is allowed state -
               * the booking resolved deterministically (earliest registration of this wallet
               * wins), and staff sees the ambiguity instead of a silent pick. */
              <p className="mt-1 text-caption text-ink-faint">
                This wallet is registered on more than one client record - this booking resolved to its earliest
                registration. Review the client link if that looks wrong.
              </p>
            )}
          </div>
        )}

        {identity.tagResolution !== "none" && (
          <div>
            <dt className="text-caption text-ink-faint">Tag claim</dt>
            <dd className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                {identity.dogTagIdDec && <span className="font-mono text-body text-ink">{identity.dogTagIdDec}</span>}
                <StatusBadge
                  tone={identity.tagResolution === "local" && !identity.needsReview ? "ok" : identity.tagResolution === "unknown" ? "neutral" : "info"}
                  label={tagResolutionLabel[identity.tagResolution]}
                />
                {/* Q4's level ladder is specifically about CHAIN-corroborated tag claims (docs/
                 * mobile-booking.md's Assurance levels table: "exists, active, issuer known") -
                 * tiers 3/4 read the chain, tier 1 (local) never does (it matches this clinic's
                 * own already-trusted client/pet records instead, a different kind of assurance
                 * the level ladder doesn't describe), and "unknown" has no assurance to label. */}
                {(identity.tagResolution === "issued_here_unlinked" || identity.tagResolution === "external") && (
                  <StatusBadge tone="neutral" label="Level 1" />
                )}
                {identity.tagResolution === "external" && identity.dataVerified && (
                  <StatusBadge tone="ok" label="Level 2 - data verified" />
                )}
              </div>

              {identity.tagResolution === "local" && identity.needsReview && (
                <Banner tone="warn" title="Needs review before treating this booking as related to that pet">
                  <p>
                    This claim named{" "}
                    <Link href={`/pets/${identity.candidatePetId}`} className="text-link hover:underline">
                      an existing pet
                    </Link>
                    , but the client this booking resolved to is not one of that pet&apos;s registered owners.
                    The pet has NOT been linked to this appointment.
                  </p>
                </Banner>
              )}

              {identity.tagResolution === "issued_here_unlinked" && (
                <Banner tone="warn" title="This clinic issued this tag, but no pet record here is linked to it">
                  <p className="mb-1">This can happen after a database restore. Pick the pet it belongs to to relink it.</p>
                  <RelinkDogTagAction appointmentId={appointment.appointmentId} onSaved={onSaved} />
                </Banner>
              )}

              {identity.tagResolution === "external" && (
                <div className="space-y-1">
                  {identity.issuerClone && (
                    <div className="flex items-center gap-2">
                      <span className="text-caption text-ink-faint">Issuer:</span>
                      <AddressChip address={identity.issuerClone} chain="roax" />
                      <StatusBadge tone={identity.issuerValid ? "ok" : "danger"} label={identity.issuerValid ? "Valid" : "Not currently valid"} />
                    </div>
                  )}
                  {/* Review finding 9: four truthful states. `verifyLeafCommitment` only RUNS
                   * when data was sent AND the issuer read back valid (resolveTagClaim's own
                   * gate) - so a non-verified result with an INVALID issuer must blame the
                   * issuer, never the data: the data was not evaluated at all. Only the final
                   * branch means the data itself failed the on-chain recompute. */}
                  <p className="text-caption text-ink-faint">
                    {identity.dataVerified
                      ? "Verified pet data was imported into a pet record for this clinic."
                      : !identity.dataVerificationAttempted
                        ? "No pet data was sent to verify - appointment only. A pet record can be created at arrival."
                        : !identity.issuerValid
                          ? "The issuer is not currently valid, so the sent pet data was not evaluated - appointment only. A pet record can be created at arrival."
                          : "The sent pet data did not verify against the on-chain record - appointment only. A pet record can be created at arrival."}
                  </p>
                </div>
              )}

              {identity.tagResolution === "unknown" && (
                <p className="text-caption text-ink-faint">
                  {identity.verificationError
                    ? "Could not verify this tag on chain - the chain may have been unreachable. Try refreshing later."
                    : "No tag was found on chain for this id."}
                </p>
              )}
            </dd>
          </div>
        )}
      </dl>
    </section>
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
    {key: "source", label: "Source", value: appointmentSourceLabel[appointment.source]},
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
      {appointment.source === "mobile" && <ProvenanceBox appointment={appointment} onSaved={refresh} />}
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
