"use client";

import {useEffect, useState} from "react";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "dogtag-vet:theme";

function applyTheme(pref: ThemePreference) {
  const root = document.documentElement;
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = pref === "dark" || (pref === "system" && systemDark);
  root.classList.toggle("dark", dark);
}

/** Inline, synchronous (no React, no async) - inject this string into a <script> tag before
 * hydration so the correct theme class is set before first paint, avoiding a light/dark flash.
 * Kept as a plain string (not a component) because it must run outside React entirely. */
export const noFlashThemeScript = `
(function () {
  try {
    var pref = localStorage.getItem("${STORAGE_KEY}") || "system";
    var systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var dark = pref === "dark" || (pref === "system" && systemDark);
    document.documentElement.classList.toggle("dark", dark);
  } catch (e) {}
})();
`;

const options: {value: ThemePreference; label: string}[] = [
  {value: "system", label: "System"},
  {value: "light", label: "Light"},
  {value: "dark", label: "Dark"},
];

/** System / light / dark tri-state toggle, persisted per browser - design-system.md's Theme
 * toggle. */
export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>("system");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY) as ThemePreference | null;
      if (stored) setPref(stored);
    } catch {
      // fall through to "system"
    }
  }, []);

  useEffect(() => {
    applyTheme(pref);
    if (pref !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(pref);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [pref]);

  function select(next: ThemePreference) {
    setPref(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // best-effort persistence only
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-control border border-border bg-surface-2 p-0.5"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={pref === opt.value}
          onClick={() => select(opt.value)}
          className={`rounded-control px-2.5 py-1 text-caption font-medium transition-colors ${
            pref === opt.value ? "bg-surface text-ink shadow-card" : "text-ink-muted hover:text-ink"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
