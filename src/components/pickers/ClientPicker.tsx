"use client";

import {useEffect, useRef, useState} from "react";
import {Combobox} from "@/components/pickers/Combobox";
import type {ClientDoc} from "@/lib/models/Client";

/** Focus falls back to `<body>` after a selection: picking an option unmounts the `<input
 * role="combobox">` that had focus during the selecting click/keypress (the `value` branch below
 * swaps it out for the chip), and the browser has nowhere else to send focus on an element's
 * removal. `focusPending` is set only inside the picker's own `onSelect` callback (never on mount,
 * even when `value` starts already populated - e.g. the appointment detail page's Edit-tagging
 * section), so this only fires for a selection this component itself just made. */
function useFocusChipOnSelect(hasValue: boolean) {
  const [focusPending, setFocusPending] = useState(false);
  const removeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (focusPending && hasValue) {
      removeButtonRef.current?.focus();
      setFocusPending(false);
    }
  }, [focusPending, hasValue]);

  return {removeButtonRef, requestFocus: () => setFocusPending(true)};
}

export interface ClientPickerProps {
  value: ClientDoc | null;
  onChange: (client: ClientDoc | null) => void;
  ariaLabel?: string;
  placeholder?: string;
  id?: string;
}

function clientSecondaryLine(client: ClientDoc): string {
  return [client.email, client.phone].filter(Boolean).join(" · ") || "No email or phone on file";
}

/**
 * Single-select accessible client search (WP4.3 B3) - replaces the hand-rolled, non-accessible
 * dropdowns `OwnerPicker` and `TagIssueWizard`'s inline client search used to each maintain
 * separately. Dropdown rows show name + email + phone (the disambiguation requirement: several
 * "John"s must be tellable apart at a glance); a selected client renders as a chip with its email.
 */
export function ClientPicker({value, onChange, ariaLabel = "Search clients", placeholder = "Search by name, email, or phone", id}: ClientPickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClientDoc[]>([]);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const {removeButtonRef, requestFocus} = useFocusChipOnSelect(value !== null);

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

  if (value) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-badge bg-brand-soft px-2.5 py-1 text-caption font-medium text-brand">
        <span>{value.name}</span>
        {value.email && <span className="font-normal opacity-80">{` - ${value.email}`}</span>}
        <button
          ref={removeButtonRef}
          type="button"
          onClick={() => onChange(null)}
          aria-label={`Remove ${value.name}`}
          className="text-brand hover:opacity-70"
        >
          x
        </button>
      </span>
    );
  }

  return (
    <Combobox<ClientDoc>
      id={id}
      ariaLabel={ariaLabel}
      placeholder={placeholder}
      query={query}
      onQueryChange={setQuery}
      options={results}
      onSelect={(client) => {
        onChange(client);
        requestFocus();
        setQuery("");
        setResults([]);
      }}
      getOptionKey={(client) => client.clientId}
      renderOption={(client) => (
        <div>
          <div className="font-medium text-ink">{client.name}</div>
          <div className="text-caption text-ink-faint">{clientSecondaryLine(client)}</div>
        </div>
      )}
      emptyHint="No matching clients"
    />
  );
}
