"use client";

import {useEffect, useMemo, useRef, useState} from "react";
import {Combobox} from "@/components/pickers/Combobox";
import {filterTimeZones, utcOffsetLabel} from "@/lib/timezones";

/** Memoized once at module scope, not per render/mount - the set of IANA zones a runtime supports
 * never changes over a process's lifetime. Empty when `Intl.supportedValuesOf` doesn't exist
 * (older browsers/runtimes) - `TimezonePicker` treats that the same as "search unsupported". */
const ALL_ZONES: string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

/** Focus falls back to `<body>` after a selection: picking an option unmounts the `<input
 * role="combobox">` that had focus during the selecting click/keypress (the `value` branch below
 * swaps it out for the chip), and the browser has nowhere else to send focus on an element's
 * removal. `ClientPicker`'s exact idiom (WP4.3 B3) - see its own copy of this hook. */
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

export interface TimezonePickerProps {
  value: string;
  onChange: (zone: string) => void;
  ariaLabel?: string;
  placeholder?: string;
  id?: string;
}

/**
 * Single-select searchable timezone picker (WP4.5 issue 2) - the third consumer of the shared
 * `Combobox` (WP4.3 B3), after `ClientPicker` and `PetMultiPicker`. Replaces a bare text `Input`
 * in `BookingConfigSection` that let `bookingSettingsSchema`'s `z.string().min(1)` store any junk:
 * `onChange` fires ONLY from `Combobox`'s `onSelect` of a listed option, so an invalid zone is
 * impossible by construction - the typed query string itself is never persisted anywhere.
 *
 * Resting state renders a chip (`ClientPicker`'s exact styling) with the zone name and a secondary
 * UTC-offset line; removing it returns to the search combobox. Search runs over the memoized
 * `Intl.supportedValuesOf("timeZone")` list - purely client-side and synchronous (unlike
 * `ClientPicker`'s debounced server fetch), so there is no loading state to manage.
 */
export function TimezonePicker({
  value,
  onChange,
  ariaLabel = "Search timezones",
  placeholder = "Search by city or region, e.g. New York",
  id,
}: TimezonePickerProps) {
  const [query, setQuery] = useState("");
  const {removeButtonRef, requestFocus} = useFocusChipOnSelect(value !== "");
  const options = useMemo(() => filterTimeZones(query, ALL_ZONES), [query]);

  if (value) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-badge bg-brand-soft px-2.5 py-1 text-caption font-medium text-brand">
        <span className="flex flex-col leading-tight">
          <span>{value}</span>
          <span className="font-normal opacity-80">{utcOffsetLabel(value)}</span>
        </span>
        <button
          ref={removeButtonRef}
          type="button"
          onClick={() => onChange("")}
          aria-label={`Remove ${value}`}
          className="text-brand hover:opacity-70"
        >
          x
        </button>
      </span>
    );
  }

  if (ALL_ZONES.length === 0) {
    // Fallback when Intl.supportedValuesOf is missing: the current value, read-only - never a
    // free-text input, which would reopen the exact "any junk stores" hole this component exists
    // to close.
    return <p className="text-body text-ink-muted">{value || "No timezone set"}</p>;
  }

  return (
    <Combobox<string>
      id={id}
      ariaLabel={ariaLabel}
      placeholder={placeholder}
      query={query}
      onQueryChange={setQuery}
      options={options}
      onSelect={(zone) => {
        onChange(zone);
        requestFocus();
        setQuery("");
      }}
      getOptionKey={(zone) => zone}
      renderOption={(zone) => (
        <div>
          <div className="font-medium text-ink">{zone}</div>
          <div className="text-caption text-ink-faint">{utcOffsetLabel(zone)}</div>
        </div>
      )}
      emptyHint="No matching timezones"
    />
  );
}
