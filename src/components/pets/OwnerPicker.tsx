"use client";

import {useEffect, useRef, useState} from "react";
import {Combobox} from "@/components/pickers/Combobox";
import type {ClientDoc} from "@/lib/models/Client";

export interface OwnerPickerProps {
  value: {clientId: string; name: string}[];
  onChange: (next: {clientId: string; name: string}[]) => void;
}

function clientSecondaryLine(client: ClientDoc): string {
  return [client.email, client.phone].filter(Boolean).join(" · ") || "No email or phone on file";
}

/** Many-to-many owners UI (wp4-vet.md): a chip list of currently-selected owners plus a
 * type-ahead search against `/api/clients` to add more. Client-side only - the actual link/unlink
 * write happens server-side (`setPetOwners`) when the pet form saves.
 *
 * Built on the same accessible `Combobox` primitive `ClientPicker` uses (WP4.3 B4) - dropdown rows
 * show name + email + phone (the same disambiguation requirement ClientPicker's rows serve) and
 * gain real combobox keyboard/ARIA semantics this component previously had none of. The external
 * contract (`{clientId, name}[]` chips, no email carried) is unchanged, so `PetForm.tsx` needs no
 * changes. */
export function OwnerPicker({value, onChange}: OwnerPickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClientDoc[]>([]);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(timeoutRef.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    timeoutRef.current = setTimeout(async () => {
      const res = await fetch(`/api/clients?q=${encodeURIComponent(query.trim())}`);
      if (res.ok) setResults(await res.json());
    }, 250);
    return () => clearTimeout(timeoutRef.current);
  }, [query]);

  const selectedIds = new Set(value.map((v) => v.clientId));
  const options = results.filter((c) => !selectedIds.has(c.clientId));

  function addOwner(client: ClientDoc) {
    onChange([...value, {clientId: client.clientId, name: client.name}]);
    setQuery("");
    setResults([]);
  }

  function removeOwner(clientId: string) {
    onChange(value.filter((v) => v.clientId !== clientId));
  }

  return (
    <div>
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {value.map((owner) => (
            <span
              key={owner.clientId}
              className="inline-flex items-center gap-1.5 rounded-badge bg-brand-soft px-2.5 py-1 text-caption font-medium text-brand"
            >
              {owner.name}
              <button
                type="button"
                onClick={() => removeOwner(owner.clientId)}
                aria-label={`Remove ${owner.name}`}
                className="text-brand hover:opacity-70"
              >
                x
              </button>
            </span>
          ))}
        </div>
      )}
      <Combobox<ClientDoc>
        ariaLabel="Search clients to add as an owner"
        placeholder="Search clients to add as an owner"
        query={query}
        onQueryChange={setQuery}
        options={options}
        onSelect={addOwner}
        getOptionKey={(client) => client.clientId}
        renderOption={(client) => (
          <div>
            <div className="font-medium text-ink">{client.name}</div>
            <div className="text-caption text-ink-faint">{clientSecondaryLine(client)}</div>
          </div>
        )}
        emptyHint="No matching clients"
      />
    </div>
  );
}
