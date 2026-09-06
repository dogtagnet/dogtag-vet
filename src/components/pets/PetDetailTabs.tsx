"use client";

import {useState} from "react";
import type {ReactNode} from "react";

/**
 * `/pets/:id`'s two-tab shell (plan section 11.2 V4: "pet page -> Records tab") - "Profile" (the
 * pre-existing tag card + edit form, unchanged) and "Records" (the new vaccination-record list this
 * wave adds). Both panels stay mounted and are toggled with `hidden` rather than conditionally
 * rendered, so `PetForm`'s own in-progress edits (and, once switched to once, `RecordsCard`'s own
 * already-fetched list) survive a tab switch instead of being torn down and refetched every time -
 * the same local-button-group idiom `PaymentRailTabs.tsx` already uses for a different pair of tabs
 * (plain `useState`, no shared tab-primitive library exists in this app to reach for instead).
 */
export function PetDetailTabs({profileTab, recordsTab}: {profileTab: ReactNode; recordsTab: ReactNode}) {
  const [active, setActive] = useState<"profile" | "records">("profile");

  return (
    <div>
      <div className="mb-6 flex gap-2" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={active === "profile"}
          onClick={() => setActive("profile")}
          className={`rounded-control border px-3 py-1.5 text-body ${
            active === "profile" ? "border-brand bg-brand-soft text-brand" : "border-border text-ink-muted hover:bg-surface-2"
          }`}
        >
          Profile
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={active === "records"}
          onClick={() => setActive("records")}
          className={`rounded-control border px-3 py-1.5 text-body ${
            active === "records" ? "border-brand bg-brand-soft text-brand" : "border-border text-ink-muted hover:bg-surface-2"
          }`}
        >
          Records
        </button>
      </div>

      <div hidden={active !== "profile"}>{profileTab}</div>
      <div hidden={active !== "records"}>{recordsTab}</div>
    </div>
  );
}
