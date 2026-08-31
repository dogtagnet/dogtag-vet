"use client";

import {useId, useState} from "react";
import type {ReactNode} from "react";
import {Input} from "@/components/ui/controls";

export interface ComboboxProps<T> {
  /** Base id for the ARIA wiring (`{id}-listbox`, `{id}-option-N`) - falls back to `useId()` when
   * omitted, so multiple comboboxes on the same page (e.g. a ClientPicker and a PetMultiPicker in
   * the same dialog) never collide. */
  id?: string;
  ariaLabel: string;
  placeholder?: string;
  query: string;
  onQueryChange: (value: string) => void;
  /** Already fetched/filtered by the caller - this component only handles the open/active-option
   * interaction, never data fetching. */
  options: T[];
  onSelect: (option: T) => void;
  getOptionKey: (option: T) => string;
  renderOption: (option: T, active: boolean) => ReactNode;
  disabled?: boolean;
  /** Shown under the input when the query is non-empty but `options` is empty - omit to show
   * nothing (e.g. while a debounced fetch is still pending). */
  emptyHint?: string;
}

/**
 * Shared accessible combobox core behind `ClientPicker` and `PetMultiPicker` (WP4.3 B3) - real
 * combobox semantics the repo previously had none of: `role="combobox"`/`listbox`/`option`,
 * `aria-expanded`/`aria-activedescendant`, ArrowUp/Down + Enter + Escape keyboard navigation, and
 * focus management. Owns only the open/active-option interaction; selection state, data fetching,
 * and "how a selected value renders" are each picker's own job.
 */
export function Combobox<T>({
  id,
  ariaLabel,
  placeholder,
  query,
  onQueryChange,
  options,
  onSelect,
  getOptionKey,
  renderOption,
  disabled,
  emptyHint,
}: ComboboxProps<T>) {
  const generatedId = useId();
  const baseId = id ?? generatedId;
  const listboxId = `${baseId}-listbox`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const showListbox = open && options.length > 0;

  function select(option: T) {
    onSelect(option);
    setOpen(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (options.length === 0) return;
      setOpen(true);
      setActiveIndex((prev) => Math.min(prev + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return;
      setActiveIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      if (open && activeIndex >= 0 && options[activeIndex]) {
        e.preventDefault();
        select(options[activeIndex]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  }

  return (
    <div className="relative">
      <Input
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={showListbox}
        aria-controls={listboxId}
        aria-activedescendant={activeIndex >= 0 ? `${baseId}-option-${activeIndex}` : undefined}
        value={query}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          onQueryChange(e.target.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onFocus={() => {
          // Unconditional, not gated on `options.length > 0` at this instant: PetMultiPicker's
          // options arrive from an async fetch that can still be in flight the moment focus
          // lands (e.g. clicking the pet search immediately after picking a client). Since
          // `showListbox` is `open && options.length > 0`, staying open-but-empty here means the
          // listbox reveals itself reactively the instant options arrive, with no second focus
          // needed - the alternative (gating this on options.length) leaves the picker looking
          // inert until the user clicks away and back.
          setOpen(true);
        }}
        onClick={() => {
          // Selecting an option deliberately keeps focus on the input (each option's onMouseDown
          // preventDefault's the blur, so a multi-select picker can accept another pick right
          // away) - which means a native "focus" event does NOT refire on a second click, since
          // focus never actually left. Reopening here too (a plain click, independent of focus)
          // is what makes "select one option, click the still-focused input again, pick another"
          // work for PetMultiPicker.
          setOpen(true);
        }}
        onBlur={() => {
          // Delayed so a mousedown on an option (which fires before this blur's click) still
          // registers - see each option's own onMouseDown below.
          window.setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={handleKeyDown}
      />
      {showListbox && (
        <ul id={listboxId} role="listbox" className="absolute z-10 mt-1 w-full rounded-control border border-border bg-surface shadow-raised">
          {options.map((option, index) => {
            const active = index === activeIndex;
            return (
              <li
                key={getOptionKey(option)}
                id={`${baseId}-option-${index}`}
                role="option"
                aria-selected={active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(option)}
                onMouseEnter={() => setActiveIndex(index)}
                className={`cursor-pointer px-3 py-2 text-body ${active ? "bg-surface-2" : ""}`}
              >
                {renderOption(option, active)}
              </li>
            );
          })}
        </ul>
      )}
      {!showListbox && open && query.trim().length > 0 && emptyHint && (
        <p className="mt-1 text-caption text-ink-faint">{emptyHint}</p>
      )}
    </div>
  );
}
