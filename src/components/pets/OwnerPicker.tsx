"use client";

import {useEffect, useRef, useState} from "react";
import {Input} from "@/components/ui/controls";
import type {ClientDoc} from "@/lib/models/Client";

export interface OwnerPickerProps {
  value: {clientId: string; name: string}[];
  onChange: (next: {clientId: string; name: string}[]) => void;
}

/** Many-to-many owners UI (wp4-vet.md): a chip list of currently-selected owners plus a
 * type-ahead search against `/api/clients` to add more. Client-side only - the actual link/unlink
 * write happens server-side (`setPetOwners`) when the pet form saves. */
export function OwnerPicker({value, onChange}: OwnerPickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClientDoc[]>([]);
  const [open, setOpen] = useState(false);
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

  function addOwner(client: ClientDoc) {
    if (selectedIds.has(client.clientId)) return;
    onChange([...value, {clientId: client.clientId, name: client.name}]);
    setQuery("");
    setResults([]);
    setOpen(false);
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
      <div className="relative">
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search clients to add as an owner"
        />
        {open && results.length > 0 && (
          <ul className="absolute z-10 mt-1 w-full rounded-control border border-border bg-surface shadow-raised">
            {results.map((client) => (
              <li key={client.clientId}>
                <button
                  type="button"
                  onClick={() => addOwner(client)}
                  className="block w-full px-3 py-2 text-left text-body hover:bg-surface-2"
                >
                  {client.name} {client.email && <span className="text-ink-faint">({client.email})</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
