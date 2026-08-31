"use client";

import {useEffect, useRef, useState} from "react";
import {Combobox} from "@/components/pickers/Combobox";
import type {PetDoc} from "@/lib/models/Pet";

export interface PetMultiPickerProps {
  /** The pets offered are always this client's own (`GET /api/pets?ownerClientId=`) - undefined
   * (no client chosen yet) disables the picker entirely. */
  clientId: string | undefined;
  value: PetDoc[];
  onChange: (next: PetDoc[]) => void;
  ariaLabel?: string;
  id?: string;
}

function petSecondaryLine(pet: PetDoc): string {
  return pet.species ? (pet.breed ? `${pet.species} · ${pet.breed}` : pet.species) : "";
}

/**
 * Multi-select accessible pet picker scoped to one client (WP4.3 B3) - lists the selected client's
 * pets, chips with remove, disabled until a client is chosen. Re-fetches whenever `clientId`
 * changes and - critically - clears any already-selected pets on a GENUINE change (one client
 * swapped for another after mount), never on the initial mount value: the appointment detail
 * page's Edit-tagging section mounts this already pre-filled with the CURRENT tagging (a valid,
 * already-consistent selection that must survive unchanged), while retagging to a different client
 * mid-session must drop pets that belonged to the PREVIOUS client - stale pets carried across a
 * retag is exactly the "pet of another client" case the server also refuses (see
 * `appointmentTagging.ts`'s `resolveTagging`). `previousClientIdRef` starts equal to the initial
 * `clientId` prop precisely so the mount-time effect run sees "no change" either way.
 */
export function PetMultiPicker({clientId, value, onChange, ariaLabel = "Search pets", id}: PetMultiPickerProps) {
  const [allPets, setAllPets] = useState<PetDoc[]>([]);
  const [query, setQuery] = useState("");
  const previousClientIdRef = useRef<string | undefined>(clientId);

  useEffect(() => {
    const changed = previousClientIdRef.current !== undefined && previousClientIdRef.current !== clientId;
    previousClientIdRef.current = clientId;

    if (changed) onChange([]);

    if (!clientId) {
      setAllPets([]);
      return;
    }
    fetch(`/api/pets?ownerClientId=${encodeURIComponent(clientId)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setAllPets);
    // Only `clientId` should re-trigger this - `onChange`/`value` are the parent's own state
    // setters/values, and including them would either loop or clear on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const selectedIds = new Set(value.map((p) => p.petId));
  const q = query.trim().toLowerCase();
  const options = allPets.filter((p) => !selectedIds.has(p.petId) && (q === "" || p.name.toLowerCase().includes(q)));

  function addPet(pet: PetDoc) {
    onChange([...value, pet]);
    setQuery("");
  }

  function removePet(petId: string) {
    onChange(value.filter((p) => p.petId !== petId));
  }

  return (
    <div>
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {value.map((pet) => (
            <span
              key={pet.petId}
              className="inline-flex items-center gap-1.5 rounded-badge bg-brand-soft px-2.5 py-1 text-caption font-medium text-brand"
            >
              {pet.name}
              <button
                type="button"
                onClick={() => removePet(pet.petId)}
                aria-label={`Remove ${pet.name}`}
                className="text-brand hover:opacity-70"
              >
                x
              </button>
            </span>
          ))}
        </div>
      )}
      <Combobox<PetDoc>
        id={id}
        ariaLabel={ariaLabel}
        placeholder={clientId ? "Search this client's pets" : "Select a client first"}
        query={query}
        onQueryChange={setQuery}
        options={options}
        onSelect={addPet}
        getOptionKey={(pet) => pet.petId}
        renderOption={(pet) => {
          const secondary = petSecondaryLine(pet);
          return (
            <div>
              <div className="font-medium text-ink">{pet.name}</div>
              {secondary && <div className="text-caption text-ink-faint">{secondary}</div>}
            </div>
          );
        }}
        disabled={!clientId}
        emptyHint={clientId ? "No matching pets" : undefined}
      />
    </div>
  );
}
